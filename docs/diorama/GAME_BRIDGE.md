# Design: Diorama — a game-like surface for AgentRoom

> Status: **implementation started**. `@agentroom/diorama-core`,
> `@agentroom/diorama-town`, `@agentroom/diorama-pixi`, and the daemon SSE event
> stream now exist; this doc remains the product/architecture design record.
> Working names: **Diorama** (the framework), **Clankton** (the reference Sims-like game). Both are placeholders — rename freely.
> Author seed: design consult, 2026-05-30.
> Companion: **`TOWN_MODE.md`** — the embodied, walk-up-and-talk *Town Mode* variant (player avatar, proximity chat, voice, procedural town). Same protocol, different camera/input/layout.

## 1. What this is

A way to build **game-like UIs over the AgentRoom (and later Clanky) ecosystem** —
where live agent/room state is expressed as an animated, clickable world instead of a
dashboard. The motivating example: a **Sims-like** scene of pixel-art clankers
that walk around, sit at desks, raise "!" bubbles when blocked, hand
tracker-linked work to each other, and that you can click to command.

The question this doc answers: *do we just build a game, or build a framework so others can?*

**Answer: build a thin framework, and the framework is mostly a protocol + a reference
renderer — not a heavy engine.** ~80% of what a game needs already exists in AgentRoom.

## 2. Why AgentRoom is already a game backend

Two facts from the existing architecture make this almost a natural fit:

1. **It's event-sourced.** `docs/ARCHITECTURE.md`: *"Everything important becomes an event.
   Materialized views are rebuildable."* State lives as an append-only log
   (`.agentroom/events.jsonl`) and current state is a projection
   (`packages/core/src/services/AgentRoomService.ts`). A game loop is *exactly*
   "consume an event stream → mutate entity state → render." We are not bolting a game onto a
   CRUD app; the backend already thinks in the right shape.

2. **The domain enums map almost 1:1 onto Sims mechanics.** No translation gymnastics:

| AgentRoom domain (`packages/core/src/domain.ts`) | Game concept |
| --- | --- |
| `Agent.state`: `idle` / `working` / `waiting` / `blocked` / `needs-human` / `reviewing` / `done` / `failed` | **sprite animation state** — idle loop, typing, thinking, "!" bubble, waving for help, celebration, slump |
| `Agent.role`: `lead` / `planner` / `implementer` / `reviewer` / `runner` / `qa` / `observer` | **character skin / sprite sheet** |
| `message.posted` (`kind`, `importance`) | **speech bubble + walk-to-recipient**; `urgent` = red bubble |
| `handoff.created` / `delegation.created` | one clanker **walks over and hands work** to another |
| external tracker work / event `taskId` refs | a **desk / workstation / job object** in the world, owned by a Sim |
| `approval.requested` / `human_escalation.created` | Sim **waves at the player**; the "click me, I need a decision" moment |
| `RuntimeBinding` (herdr/tmux pane) | which **machine** the Sim is sitting at |
| `runtime.output_observed` / `runtime.input_sent` | the terminal *is* the Sim's thought stream — peek inside on click |
| `Workspace` / `channelId` | **rooms / zones** of the floor plan |

Commands already exist as REST on the daemon (`apps/daemon/src/app.ts`) for the
runtime and room primitives: launch agent, send input, stop, post message, and
ask-human. Delegation is represented as a tracker-linked prompt to an agent; the
core app does not expose native task create/claim/approve routes. So "click a
Sim → tell it what to do" is wired at the API level without adding a task store.

## 3. Architectural placement (do not pollute core)

The game is a **surface**, a *consumer* of the daemon — it sits where the architecture
diagram already says `Human UIs / bots / custom app` go. It is peer to the TUI, the iOS app,
and the Expo client. It introduces **no new core concept**.

```text
        Diorama renderer  (PixiJS scene / SpriteKit / Godot)
                 │
        Diorama core  (world model: reduce events → world snapshot, layout, commands)
                 │   speaks the "World Protocol" (JSON over SSE + REST)
                 ▼
            agentroomd            ← unchanged except one new read endpoint
                 │
        EventStore / RuntimeProvider / ChatGatewayProvider
```

**Hard rule, consistent with `agent-room/CLAUDE.md` and the provider-neutral model:** spatial
position, animation state, sprite skins, pathing, and world layout are **client-side
presentation concerns**. They never enter `packages/core` domain types or the event log. The
backend stays semantic; the world is *derived*. (See §6 for why deterministic derivation is
enough, and §10 for the one exception if we ever want shared multiplayer positions.)

This keeps the door open to a second data source later (Clanky's personal Pi agent already
exposes an HTTP/WebSocket API per `agent-room/CLAUDE.md`) feeding the *same* world via a
pluggable **Source adapter** — see §4.5.

## 4. The framework = a protocol + four small pieces

The reusable "framework" is **mostly a language-neutral contract** (the *World Protocol*),
plus a reference implementation of the core. The contract is what lets web, desktop, and iOS
all participate without sharing a runtime. Four pieces:

### 4.1 Transport — add a live event stream to the daemon

Today everything is polling (~1–2s, 20–30 requests/cycle in `apps/tui/src/poller.ts` and the
iOS `loadSnapshot`). Fine for a dashboard, too laggy/wasteful for a 60fps game.

**The primitive already exists.** `AgentRoomService.eventCursor()` /
`listEventsFromCursor()` is what the MCP server uses for agent `wait`s. We just expose it over
a streaming HTTP route:

```
GET /v1/events/stream?cursor=<pos>     → text/event-stream (SSE)
    event: room-event
    data: { …RoomEvent… }
```

SSE over WebSocket because the stream is **one-directional** (server→client); commands go over
the existing REST endpoints. SSE is simpler, proxy-friendly, auto-reconnects, and works
unchanged in browsers, Tauri/Electron, and `URLSession`/`WKWebView` on iOS. (Clanky's existing
WS API is the fallback pattern if we later need bidirectional.) Bearer-token auth reuses the
existing `/v1/*` middleware. This is the **only required daemon change** and is ~a day.

### 4.2 World Snapshot — the denormalized state a renderer binds to

`Diorama core` keeps a cursor, replays from the SSE stream, and maintains a reactive,
**denormalized** snapshot. The renderer never touches raw events; it binds to this:

```ts
interface WorldSnapshot {
  rooms: Record<Id, WorldRoom>          // from Workspace / channelId
  entities: Record<Id, WorldEntity>     // agents (+ later humans, bots)
  objects: Record<Id, WorldObject>      // external work refs rendered as desks/jobs
  links: WorldLink[]                    // active handoffs / delegations / DMs
  effects: WorldEffect[]                // transient: bubbles, "!", celebrations
  clock: { cursor: string; lastEventAt: ISODateTime }
}

interface WorldEntity {
  id: Id
  kind: 'agent'
  role: AgentRole                       // → skin
  domainState: AgentState               // raw truth from the projection
  presentation: {                       // DERIVED, client-only
    animation: AnimationState           // 'idle' | 'typing' | 'thinking' | 'alert' | 'celebrate' | …
    position: Vec2                       // assigned by layout strategy (§4.4)
    intent?: MoveIntent                  // "walk to object X" / "approach entity Y"
    badge?: 'needs-human' | 'blocked'
  }
  lastHeartbeatAt?: ISODateTime
}
```

The renderer is dumb and reactive: diff snapshot → tween sprites. All "smarts" (what
animation, where to stand, which effect to spawn) live in core and are **fully typed** (no
`any`, per `dev/CLAUDE.md`).

### 4.3 Skin Map — the theming seam (this is the reusability story)

A **declarative map** from domain facts → visual assets/behaviors. Swapping it is how the same
bridge powers a Sims game, a spaceship crew, or a clanker factory — *same data, different
costume*. Defaults ship; everything is overridable.

```ts
interface SkinMap {
  roleSkins: Record<AgentRole, SpriteSheetRef>
  stateAnimations: Record<AgentState, AnimationState>     // domain → anim
  eventEffects: Partial<Record<RoomEventType, EffectSpec>> // e.g. handoff.created → "carry item, walk"
  importanceStyles: Record<Importance, BubbleStyle>
  objectSkins: { task: Record<TaskStatus, SpriteRef> }    // desk states
  theme: { tileset: TilesetRef; palette: PaletteRef }
}
```

`stateAnimations` is the heart of "Sims": `blocked → 'alert'`, `needs-human → 'wave'`,
`working → 'typing'`, `done → 'celebrate'`. Asset production (the actual pixel art) is a
separate workstream — you already have `dev/game-asset-pipeline` and `dev/ft-gen` nearby that
could generate sprite sheets.

### 4.4 Layout strategy — owns space, because the backend doesn't

There is **no position data in AgentRoom** (confirmed: agents have only a `RuntimeBinding`, no
x/y). So core owns a pluggable layout policy:

```ts
interface LayoutStrategy {
  placeEntity(entity, world): Vec2          // stable, seeded by entity id → same spot each load
  placeObject(object, world): Vec2          // task desk position, grouped by assignee/room
  moveIntentFor(event, world): MoveIntent[] // handoff → walk path; message → approach recipient
  roomBounds(room, world): Rect             // workspace/channel → floor zone
}
```

Default strategy: **deterministic, seeded by id** so a clanker stands in the same place every
session (no random jitter — see `dev/CLAUDE.md` "no fallback/random"). Rooms map to floor
zones; agents cluster near their assigned task desks; handoffs generate a walk path between
two desks. Swappable for grid, org-chart, or free-roam layouts.

### 4.5 Command API + Source adapter

Commands are thin typed wrappers over existing REST, so "click → act" is uniform:

```ts
interface WorldCommands {
  sendInput(agentId, text): Promise<void>          // POST /v1/runtime/:p/agents/:id/input
  launch(spec): Promise<void>                       // POST /v1/runtime/:p/agents
  stop(agentId): Promise<void>
  delegate(agentId, work): Promise<void>
  post(channelId, body): Promise<void>
  resolveEscalation(id, answer): Promise<void>
}
```

A **Source adapter** abstracts where events/commands come from, so a world can be backed by an
AgentRoom daemon today and a Clanky daemon later, without the renderer knowing:

```ts
interface WorldSource {
  subscribe(cursor, onEvent): Subscription   // SSE for AgentRoom; WS for Clanky
  commands: WorldCommands
}
```

## 5. Cross-platform strategy (your question, answered)

> *"Is it possible to use one framework that works on web, desktop, AND iOS?"*

**Yes.** The split in §4 is exactly what makes it possible: the **World Protocol is
language-neutral JSON**, so the renderer can be anything per platform while the contract stays
identical. Three credible strategies, with a real tradeoff between *single codebase* and
*native feel*:

| | A. Web tech, wrapped (recommended) | B. Cross-platform game engine | C. Native renderer per platform |
| --- | --- | --- | --- |
| **Stack** | TS `Diorama core` + **PixiJS** (WebGL) renderer | **Godot** or **Flutter + Flame** | TS core; **PixiJS** on web, **SpriteKit** on iOS |
| **Web** | native | export to WASM/HTML5 | native (Pixi) |
| **Desktop** | **Tauri** (tiny Rust shell + system WebView) or Electron | native export | Tauri/Electron |
| **iOS** | PixiJS inside a **WKWebView** in the existing SwiftUI app (or Capacitor) | native export | **SpriteKit** (fully native) |
| **Codebase** | **one** | **one** | core shared, **two renderers** |
| **Lives in** | your TS monorepo, ships as `@agentroom/diorama-*` | outside TS/Swift; reimplements the client | TS monorepo + Swift binding |
| **iOS feel** | WebGL canvas (Metal-backed; great for 2D pixel) | near-native | fully native |
| **Effort** | lowest | medium (new engine/lang) | highest |

**Recommendation: Option A.** For a 2D pixel sprite game, PixiJS in a `WKWebView` on an iPhone
17 Pro is WebGL→Metal and more than smooth enough — and it gives you one codebase that drops
into the existing `agent-room-ios` app as a single hosted view, plus web and Tauri desktop for
free. It also keeps the framework inside your TS ecosystem as publishable
`@agentroom/diorama-core` / `@agentroom/diorama-pixi` packages others can `pnpm add`.

**The choice is reversible by design.** Because the World Protocol is the real boundary, you
can later swap the iOS surface from PixiJS-in-WebView to native SpriteKit (Option C) — or move
the whole thing to Godot (Option B) — *without touching the daemon, the protocol, or the skin
map.* So start with A; upgrade iOS to native only if the WebView ever feels insufficient.

> Note: this contradicts the usual "native SwiftUI for iOS 26" instinct from your global
> guidance. That instinct is right for *app chrome*; a real-time sprite game canvas is the one
> place a shared WebGL surface beats maintaining two renderers. Flagging it explicitly so it's
> a deliberate call, not an oversight.

## 6. Why deterministic derivation is enough (no backend positions)

A reasonable worry: "if positions are client-side, won't two viewers see different worlds?"
For a single-player **observer/controller** game (you watching *your* room), no — the layout
is a pure function of `(world snapshot, seed)`, so every client computes the same scene. We
get spatial consistency for free without a `position` field in core. We only need
backend-owned positions if we later want **multiple humans co-present in one synchronized
world with shared, mutable placement** — deferred to §10.

## 7. Reference game sketch — "Clankton"

A small Sims-like proving the framework end-to-end and serving as the template others copy:

- **Floor plan** from workspaces/channels; external work refs can render as desks; agents are clankers.
- **Idle**: clankers wander/idle near their desks. **Working**: sit + typing animation,
  progress inferred from agent/tracker events. **Blocked / needs-human**: "!" bubble, wave — clicking opens
  the resolve/answer flow (`/v1/human-escalations`, send-input).
- **Messages**: a clanker walks toward the recipient and emits a speech bubble; `urgent` glows.
- **Handoff/delegation**: carry-item walk animation from one desk to another.
- **Click a clanker** → inspector panel with the live terminal scrollback
  (`runtime.output_observed`) and a command bar (send input, stop, delegate).
- **Done**: brief celebration; any derived work object can flip to a "done" skin.

## 8. Free superpower: replay / time-travel

Because the backend is event-sourced, the same reducer that builds the live world can replay
the log from any cursor. That gives, with near-zero extra work:

- **Timelapse / cutscene** of a whole day of agent work — scrub, pause, fast-forward.
- **Deterministic debugging** of the UI (feed a recorded log).
- **Demos** that don't need a live room.

This is a genuinely strong feature for a Sims-like and falls out of the architecture, not extra
engineering.

## 9. What has to change in the ecosystem

Deliberately minimal — almost everything is additive and client-side:

1. **Daemon (required):** add `GET /v1/events/stream` SSE route wrapping the existing
   `eventCursor` / `listEventsFromCursor`. Reuse `/v1/*` bearer auth. *(~1 day.)*
2. **New packages (the framework):** `@agentroom/diorama-core` (protocol types, reducer,
   layout, commands, source adapter) and `@agentroom/diorama-pixi` (reference renderer).
3. **Skin/asset pipeline:** sprite sheets per role + animation state (leverage
   `dev/game-asset-pipeline` / `dev/ft-gen`).
4. **iOS (Option A):** host the web bundle in a `WKWebView` view inside `agent-room-ios`,
   bridging the existing connection settings/token. No new networking layer needed.
5. **No core domain changes. No event-schema changes. No SQLite dependency.** (The roadmap's
   SQLite item helps replay performance later but isn't required for MVP — JSONL replays fine.)

## 10. Open questions / decisions for you

1. **Confirm Option A** (TS + PixiJS, wrapped for desktop/iOS) vs B (Godot/Flutter) vs C
   (native SpriteKit on iOS). Recommendation: A, because the protocol makes it reversible.
2. **Single-player observer vs multiplayer co-presence.** MVP assumes single-player
   (deterministic client positions, §6). Multiplayer shared positions would require a
   backend-owned `presence`/`position` concept — a real domain change to defer until wanted.
3. **Scope of "for others."** Is the goal a polished Sims game first, with the framework
   *falling out* of it? Or framework-first with Clankton as a thin demo? (Recommend:
   build Clankton and the framework together, extracting `diorama-core` as the seam hardens.)
4. **Clanky as a second source** now or later — affects whether `WorldSource` ships in v1 or
   is designed-for-but-stubbed.
5. **Names.** Diorama / Clankton are placeholders.

## 11. Suggested phasing (when you're ready to build)

1. **Spike:** daemon SSE route + a throwaway PixiJS scene that draws one moving sprite per live
   agent, animation driven by `Agent.state`. Proves the loop end-to-end on real room data.
2. **Core extraction:** formalize `WorldSnapshot`, reducer, `LayoutStrategy`, `SkinMap`,
   `WorldCommands` as `@agentroom/diorama-core` with full types and tests on the reducer
   (the one piece worth testing per `CLAUDE.md` — it's a stable invariant: events → world).
3. **Clankton:** real sprites, rooms, click-to-command, inspector with live terminal.
4. **Wrap:** Tauri desktop build + `WKWebView` host in `agent-room-ios`.
5. **Replay mode** + **skin theming** docs so others can reskin.

---

### Appendix: key source references

- Domain & states: `agent-room/packages/core/src/domain.ts`
- Events: `agent-room/packages/core/src/events.ts`
- State projections: `agent-room/packages/core/src/services/AgentRoomService.ts`
- Event cursor primitive (basis for SSE): same service, `eventCursor` / `listEventsFromCursor`
- Daemon REST (commands + where the stream route goes): `agent-room/apps/daemon/src/app.ts`
- Existing client contract to mirror: `agent-room-ios/SwarmiOS/Services/AgentRoomAPIClient.swift`
- Architecture principles (event-first, provider-neutral): `agent-room/docs/ARCHITECTURE.md`
