/**
 * Clankton — runnable web harness for the `@agentroom/diorama-pixi` reference
 * renderer (Phase 1 inhabitable spike).
 *
 * HOW TO RUN (once `pixi.js` is installed):
 *
 *   1. From the repo root install deps so `pixi.js` and the workspace packages
 *      resolve:               pnpm install
 *   2. Start the AgentRoom daemon on :4317 (the live room) and obtain its `/v1`
 *      bearer token. Export both for this harness:
 *                             export DIORAMA_BASE_URL="http://127.0.0.1:4317"
 *                             export DIORAMA_TOKEN="<your /v1 bearer token>"
 *   3. Serve this `example/` directory with any TS-aware dev server that does
 *      module resolution + env injection, e.g. Vite:
 *                             pnpm --filter @agentroom/diorama-pixi exec \
 *                               vite packages/diorama-pixi/example
 *      or esbuild's dev server bundling `main.ts` as an ES module.
 *   4. Open the printed URL. The harness connects to the daemon's SSE stream,
 *      derives the town, and drops you at the entrance plaza. Move with WASD or
 *      the arrow keys.
 *
 * The harness needs the daemon reachable on :4317 PLUS a valid token; without
 * them the SSE subscription cannot authenticate and the town stays empty (it
 * never fabricates agents — see `dev/CLAUDE.md` "no fallback data").
 *
 * Vite exposes string env via `import.meta.env`; this file reads
 * `VITE_DIORAMA_BASE_URL` / `VITE_DIORAMA_TOKEN` first (Vite convention) and
 * falls back to a same-origin `:4317` default for the base URL only.
 */

import type { RoomEvent } from "@agentroom/core";
import {
  buildWorld,
  createDeterministicLayout,
  createSseWorldSource,
  createEmptyWorldSnapshot,
  defaultSkinMap,
} from "@agentroom/diorama-core";
import type {
  ReducerDeps,
  Subscription,
  WorldSnapshot,
} from "@agentroom/diorama-core";
import {
  buildCollisionGrid,
  buildTownPlan,
  followCamera,
  inputFromKeys,
  stepPlayer,
} from "@agentroom/diorama-town";
import type {
  CameraOptions,
  CameraState,
  CollisionGrid,
  PlayerState,
  TownLayoutOptions,
  TownPlan,
} from "@agentroom/diorama-town";
import { createRenderer } from "../src/index.js";

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

/**
 * Minimal typed view of the Vite-injected env this harness consumes. Declared as
 * an `ImportMeta` augmentation so `import.meta.env` is properly typed without a
 * cast (Vite would otherwise supply this via `vite/client`).
 */
interface HarnessEnv {
  readonly VITE_DIORAMA_BASE_URL?: string;
  readonly VITE_DIORAMA_TOKEN?: string;
}

declare global {
  interface ImportMeta {
    readonly env: HarnessEnv;
  }
}

const env = import.meta.env;

/** Daemon base URL — the live room daemon on :4317 by default. */
const BASE_URL = env.VITE_DIORAMA_BASE_URL ?? "http://127.0.0.1:4317";
/** `/v1` bearer token. Required for the daemon's auth guard. */
const TOKEN = env.VITE_DIORAMA_TOKEN;

/** Viewport size in CSS pixels. */
const VIEW_W = 960;
const VIEW_H = 640;

/** Town tile edge length in world (pixel) units. */
const TILE_SIZE = 32;

const LAYOUT_OPTS: TownLayoutOptions = { tileSize: TILE_SIZE };

const REDUCER_DEPS: ReducerDeps = {
  layout: createDeterministicLayout(),
  skin: defaultSkinMap,
};

// ---------------------------------------------------------------------------
// Live world state — events accumulate; the world is rebuilt from the log.
// ---------------------------------------------------------------------------

/**
 * The full ordered event log seen so far. `buildWorld` folds the whole log into
 * a snapshot; the reducer is idempotent on replay, so rebuilding from scratch on
 * every event is correct (and simple) for this spike. The resume cursor is kept
 * separately for reconnection.
 */
const eventLog: RoomEvent[] = [];

/** The current derived world snapshot and its town plan + collision grid. */
let world: WorldSnapshot = createEmptyWorldSnapshot();
let plan: TownPlan = buildTownPlan(world, LAYOUT_OPTS);
let grid: CollisionGrid = buildCollisionGrid(plan);

/** Pressed key names, filled by the keyboard listeners. */
const pressed = new Set<string>();

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mount = document.getElementById("app");
  if (mount === null) {
    throw new Error("harness: #app mount element not found");
  }

  const renderer = createRenderer({
    width: VIEW_W,
    height: VIEW_H,
    skin: defaultSkinMap,
  });
  await renderer.init();
  mount.appendChild(renderer.canvas);

  // Player starts at the town entrance spawn (a guaranteed-walkable plaza tile).
  let player: PlayerState = {
    position: { x: plan.spawn.x, y: plan.spawn.y },
    facing: "down",
    moving: false,
    animation: "idle",
  };

  // Camera starts centered on the spawn, clamped to the town.
  let camera: CameraState = followCamera(
    { position: { x: 0, y: 0 } },
    player.position,
    cameraOptions(plan),
  );

  // --- live event subscription -------------------------------------------
  const source = createSseWorldSource(
    TOKEN !== undefined ? { baseUrl: BASE_URL, token: TOKEN } : { baseUrl: BASE_URL },
  );

  const subscription: Subscription = source.subscribe(
    "start",
    (event: RoomEvent): void => {
      eventLog.push(event);
      // Rebuild the world (idempotent replay) and re-derive the town. The plan
      // is stable as agents join, so existing buildings do not move.
      world = buildWorld(eventLog, REDUCER_DEPS);
      plan = buildTownPlan(world, LAYOUT_OPTS);
      grid = buildCollisionGrid(plan);
    },
  );
  window.addEventListener("beforeunload", () => subscription.close());

  // --- input --------------------------------------------------------------
  window.addEventListener("keydown", (ev: KeyboardEvent): void => {
    if (isMovementKey(ev.key)) {
      pressed.add(ev.key);
      ev.preventDefault();
    }
  });
  window.addEventListener("keyup", (ev: KeyboardEvent): void => {
    pressed.delete(ev.key);
  });
  // Dropping focus should not leave keys "stuck" down.
  window.addEventListener("blur", () => pressed.clear());

  // --- frame loop ---------------------------------------------------------
  // We integrate against an explicit per-frame dt (ms) measured from the
  // rAF timestamp; the game logic itself reads no wall-clock, so determinism
  // lives in `diorama-town`. This loop just supplies dt and input.
  let lastTs: number | undefined;

  const frame = (ts: number): void => {
    const dtMs = lastTs === undefined ? 16 : ts - lastTs;
    lastTs = ts;

    const input = inputFromKeys(pressed);
    player = stepPlayer(player, input, dtMs, grid);
    camera = followCamera(camera, player.position, cameraOptions(plan));

    renderer.update(world, plan, camera, player);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Camera options derived from the current plan's world bounds. */
function cameraOptions(townPlan: TownPlan): CameraOptions {
  return {
    viewport: { w: VIEW_W, h: VIEW_H },
    // A centered dead-zone roughly a third of the viewport: the player roams the
    // middle before the camera scrolls.
    deadZone: { w: VIEW_W / 3, h: VIEW_H / 3 },
    worldBounds: townPlan.bounds,
  };
}

/** Whether a key name is one of the movement keys the player loop consumes. */
function isMovementKey(key: string): boolean {
  return MOVEMENT_KEYS.has(key);
}

const MOVEMENT_KEYS: ReadonlySet<string> = new Set([
  "w",
  "W",
  "a",
  "A",
  "s",
  "S",
  "d",
  "D",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

void main();
