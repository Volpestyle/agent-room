/**
 * `@agentroom/diorama-pixi` — the reference PixiJS (v8) renderer for the
 * inhabitable Clankton town (Phase 1).
 *
 * This is the *reference* renderer, not the verified deliverable. It binds to
 * the pure game state produced by `@agentroom/diorama-town` (a {@link TownPlan},
 * a {@link CameraState}, and a {@link PlayerState}) plus the live
 * {@link WorldSnapshot} from `@agentroom/diorama-core`, and paints it with
 * PLACEHOLDER art — colored {@link Graphics} quads for tiles and entities. The
 * art is deliberately swappable: {@link DioramaRenderer.loadSkinAtlas} is the
 * documented seam where placeholder Graphics get replaced by real Aseprite-atlas
 * sprites, driven by the {@link SkinMap}. No sprite-forge path is hardcoded
 * anywhere — the atlas is supplied by the caller through a {@link SpriteSheetRef}.
 *
 * Rendering structure (a single world {@link Container} scrolled by the camera):
 *
 *   stage
 *   └─ world            (position = -camera.position)
 *      ├─ tileLayer     (one Graphics quad per TownPlan tile, by TileKind)
 *      ├─ entityLayer   (one node per WorldEntity; painter-sorted by world-y)
 *      └─ player        (the local avatar; sorted into the entity layer by y)
 *
 * The world container's position negates the camera position so scrolling the
 * camera right moves the world left, etc. Within {@link DioramaRenderer.update}
 * the entity layer is diffed against the snapshot (add / remove / move) and
 * re-sorted by world-y for correct painter's-algorithm overlap.
 *
 * Strict TS, no `any`, no fallback/fabricated data (`dev/CLAUDE.md`). Presentation
 * is deterministic: colors are keyed by role/tile-kind, never randomized, and the
 * renderer reads no wall-clock for layout.
 *
 * NOTE: `pixi.js` is not installed in this round; this file is written against
 * the Pixi v8 API and compiled once the dependency lands.
 */

import { Application, Container, Graphics } from "pixi.js";
import type { AgentRole } from "@agentroom/core";
import type {
  SkinMap,
  SpriteSheetRef,
  Vec2,
  WorldEntity,
  WorldSnapshot,
} from "@agentroom/diorama-core";
import type {
  CameraState,
  PlayerState,
  TileKind,
  TownPlan,
} from "@agentroom/diorama-town";

// ---------------------------------------------------------------------------
// Placeholder palette — deterministic, keyed by domain facts (no randomness).
// ---------------------------------------------------------------------------

/**
 * Placeholder fill color per {@link TileKind}. Real art arrives through
 * {@link DioramaRenderer.loadSkinAtlas} + the {@link SkinMap} theme tileset; until
 * then these flat quads make the floor plan legible.
 */
const TILE_COLORS: Record<TileKind, number> = {
  ground: 0x2e3b2e,
  path: 0x6b5d44,
  building: 0x3a3f52,
  plaza: 0x4a5a3a,
};

/**
 * Placeholder fill color per agent {@link AgentRole}. Swapped for the role's
 * {@link SpriteSheetRef} skin once an atlas is loaded.
 */
const ROLE_COLORS: Record<AgentRole, number> = {
  lead: 0xffd166,
  planner: 0x06d6a0,
  implementer: 0x118ab2,
  reviewer: 0xef476f,
  runner: 0xf78c6b,
  qa: 0x8d99ae,
  observer: 0xadb5bd,
  custom: 0xc77dff,
};

/** Placeholder fill color for the local player avatar. */
const PLAYER_COLOR = 0xffffff;

/** Placeholder avatar footprint (world px) for entities and the player. */
const AVATAR_SIZE = 24;

// ---------------------------------------------------------------------------
// Construction.
// ---------------------------------------------------------------------------

/** Construction options for {@link createRenderer} / {@link DioramaRenderer}. */
export interface RendererOptions {
  /** Canvas/viewport width in CSS pixels. */
  width: number;
  /** Canvas/viewport height in CSS pixels. */
  height: number;
  /**
   * The active skin. Colors are derived from roles today; this is also the
   * swap-in point for real sprite atlases via {@link DioramaRenderer.loadSkinAtlas}.
   */
  skin: SkinMap;
}

/**
 * A loaded sprite atlas handle. The reference renderer keeps these registered so
 * a future revision can blit atlas frames in place of the placeholder Graphics.
 * It carries no Pixi texture type yet (the placeholder renderer does not bind
 * textures), only the originating {@link SpriteSheetRef}.
 */
export interface LoadedSkinAtlas {
  /** The sheet that was requested. */
  ref: SpriteSheetRef;
}

/**
 * One tracked entity node: its placeholder Graphics plus the last world position
 * we drew it at, so {@link DioramaRenderer.update} can diff cheaply.
 */
interface EntityNode {
  graphics: Graphics;
  position: Vec2;
}

/**
 * The PixiJS reference renderer. Construct via {@link createRenderer}, call
 * {@link DioramaRenderer.init} once (it awaits Pixi v8's async `Application.init`),
 * mount {@link DioramaRenderer.canvas} into the DOM, then call
 * {@link DioramaRenderer.update} every frame with the latest game state.
 */
export class DioramaRenderer {
  private readonly app: Application;
  private readonly world: Container;
  private readonly tileLayer: Container;
  private readonly entityLayer: Container;
  private readonly playerNode: Graphics;

  private readonly skin: SkinMap;
  private readonly width: number;
  private readonly height: number;

  /** Entity nodes by entity id, for add/remove/move diffing. */
  private readonly entityNodes = new Map<string, EntityNode>();
  /** Registered sprite atlases by sheet src, for the future art swap. */
  private readonly atlases = new Map<string, LoadedSkinAtlas>();

  /** The TownPlan currently rasterized into the tile layer, if any. */
  private renderedPlan: TownPlan | undefined;

  /** True once {@link init} has resolved. */
  private initialized = false;

  constructor(opts: RendererOptions) {
    this.skin = opts.skin;
    this.width = opts.width;
    this.height = opts.height;

    this.app = new Application();
    this.world = new Container();
    this.tileLayer = new Container();
    this.entityLayer = new Container();
    this.playerNode = new Graphics();

    // The player rides in the entity layer so it painter-sorts against agents by
    // world-y; tiles always sit underneath.
    this.world.addChild(this.tileLayer);
    this.world.addChild(this.entityLayer);
    this.entityLayer.addChild(this.playerNode);

    this.drawAvatar(this.playerNode, PLAYER_COLOR);
  }

  /**
   * Initialize the underlying Pixi v8 {@link Application}. Pixi v8 made init
   * asynchronous (`await app.init({...})`), so this must be awaited before the
   * canvas is mounted or {@link update} is called. Idempotent.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.app.init({
      width: this.width,
      height: this.height,
      antialias: false,
      backgroundColor: 0x1b1f1b,
      autoStart: false,
    });
    this.app.stage.addChild(this.world);
    this.initialized = true;
  }

  /** The backing canvas element to mount into the DOM (Pixi v8 `app.canvas`). */
  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /**
   * Documented art-swap seam. Register a real sprite atlas (an Aseprite-packed
   * sheet, referenced by the {@link SkinMap}) so a future revision can blit its
   * frames in place of the placeholder Graphics. The {@link SkinMap} is the swap-in
   * point: `skin.roleSkins[role]` and `skin.theme.tileset` name the sheets to load.
   *
   * The reference renderer registers the handle but keeps drawing placeholders —
   * binding `Texture`/`Spritesheet` is intentionally out of scope for the Phase 1
   * spike. No asset path is hardcoded here; the `ref.src` comes entirely from the
   * caller-supplied {@link SkinMap}.
   */
  async loadSkinAtlas(ref: SpriteSheetRef): Promise<LoadedSkinAtlas> {
    const existing = this.atlases.get(ref.src);
    if (existing !== undefined) return existing;
    // Real implementation (future): `const sheet = await Assets.load(ref.src)`
    // then slice `ref.frames` frames of `ref.frameWidth`×`ref.frameHeight` into
    // an animated sprite, registered by role. The spike keeps placeholders.
    const loaded: LoadedSkinAtlas = { ref };
    this.atlases.set(ref.src, loaded);
    return loaded;
  }

  /**
   * Draw one frame.
   *
   * 1. Rasterize the tile layer if the {@link TownPlan} changed (cheap identity
   *    check — the plan is rebuilt only when the world snapshot changes).
   * 2. Diff the entity layer against the snapshot: add nodes for new entities,
   *    remove nodes for departed ones, move surviving nodes to their layout
   *    position.
   * 3. Place the player node at its simulated position.
   * 4. Painter-sort the entity layer by world-y (lower y draws first / behind).
   * 5. Scroll the world container to negate the camera position.
   */
  update(
    world: WorldSnapshot,
    plan: TownPlan,
    camera: CameraState,
    player: PlayerState,
  ): void {
    if (!this.initialized) {
      throw new Error("DioramaRenderer.update called before init() resolved");
    }

    if (this.renderedPlan !== plan) {
      this.rasterizeTiles(plan);
      this.renderedPlan = plan;
    }

    this.syncEntities(world);

    this.playerNode.position.set(player.position.x, player.position.y);

    this.sortEntityLayerByY();

    // Negate the camera: scrolling the camera right shifts the world left.
    this.world.position.set(-camera.position.x, -camera.position.y);

    this.app.renderer.render(this.app.stage);
  }

  /** Tear down the Pixi application and release GPU resources. */
  destroy(): void {
    this.app.destroy(true, { children: true });
    this.entityNodes.clear();
    this.atlases.clear();
    this.initialized = false;
  }

  // -------------------------------------------------------------------------
  // Tile layer.
  // -------------------------------------------------------------------------

  /**
   * Repaint the tile layer from the plan. One {@link Graphics} quad per tile,
   * filled by {@link TileKind}. Placeholder art — real art arrives via the skin
   * theme tileset through {@link loadSkinAtlas}.
   */
  private rasterizeTiles(plan: TownPlan): void {
    this.tileLayer.removeChildren();
    const { cols, rows, tileSize, tiles } = plan;
    const floor = new Graphics();
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const kind = tiles[row * cols + col];
        if (kind === undefined) continue;
        floor
          .rect(col * tileSize, row * tileSize, tileSize, tileSize)
          .fill(TILE_COLORS[kind]);
      }
    }
    this.tileLayer.addChild(floor);
  }

  // -------------------------------------------------------------------------
  // Entity layer.
  // -------------------------------------------------------------------------

  /** Add / remove / move entity nodes to match the snapshot. */
  private syncEntities(world: WorldSnapshot): void {
    const seen = new Set<string>();

    for (const entity of Object.values(world.entities)) {
      seen.add(entity.id);
      const pos = entity.presentation.position;
      const node = this.entityNodes.get(entity.id);
      if (node === undefined) {
        this.addEntityNode(entity, pos);
      } else if (node.position.x !== pos.x || node.position.y !== pos.y) {
        node.graphics.position.set(pos.x, pos.y);
        node.position = { x: pos.x, y: pos.y };
      }
    }

    // Remove nodes whose entity left the world.
    for (const [id, node] of this.entityNodes) {
      if (!seen.has(id)) {
        this.entityLayer.removeChild(node.graphics);
        node.graphics.destroy();
        this.entityNodes.delete(id);
      }
    }
  }

  /** Create a placeholder Graphics node for a new entity, keyed by role color. */
  private addEntityNode(entity: WorldEntity, pos: Vec2): void {
    const graphics = new Graphics();
    // The SkinMap maps role → sprite sheet (skin.roleSkins[role]); real atlases
    // are bound later via loadSkinAtlas. Until one is registered for this role's
    // sheet, draw a placeholder tinted by role.
    const sheet = this.skin.roleSkins[entity.role];
    const hasAtlas = sheet !== undefined && this.atlases.has(sheet.src);
    if (!hasAtlas) {
      this.drawAvatar(graphics, ROLE_COLORS[entity.role]);
    }
    graphics.position.set(pos.x, pos.y);
    this.entityLayer.addChild(graphics);
    this.entityNodes.set(entity.id, { graphics, position: { x: pos.x, y: pos.y } });
  }

  /**
   * Painter's-algorithm z-order: sort entity-layer children by their world-y so
   * a node lower on the floor draws in front of (after) one higher up. Pixi v8
   * sorts children by `zIndex` when `sortableChildren` is on; we set each child's
   * zIndex to its y and sort.
   */
  private sortEntityLayerByY(): void {
    for (const child of this.entityLayer.children) {
      child.zIndex = child.position.y;
    }
    this.entityLayer.sortableChildren = true;
    this.entityLayer.sortChildren();
  }

  /**
   * Paint a placeholder avatar quad of {@link AVATAR_SIZE}, centered on the node's
   * origin so the node's position is the avatar's world center (matching how the
   * player/entity positions are world-center coordinates).
   */
  private drawAvatar(graphics: Graphics, color: number): void {
    const half = AVATAR_SIZE / 2;
    graphics.clear();
    graphics.rect(-half, -half, AVATAR_SIZE, AVATAR_SIZE).fill(color);
  }
}

/**
 * Construct a {@link DioramaRenderer}. Remember to `await renderer.init()` before
 * mounting `renderer.canvas` or calling `renderer.update(...)`.
 */
export function createRenderer(opts: RendererOptions): DioramaRenderer {
  return new DioramaRenderer(opts);
}
