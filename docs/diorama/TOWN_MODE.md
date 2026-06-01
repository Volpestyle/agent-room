# Design: Town Mode — an embodied, walk-up-and-talk Diorama

> Status: **implementation started**. Core/town/pixi packages now exist; this
> doc remains the embodied-mode design record.
> Working names: **Diorama** (framework), **Clankton** (reference game), **Town Mode** (this embodied variant). Placeholders — rename freely.
> Companion: **`GAME_BRIDGE.md`** — the framework + protocol + observer-mode design. Read it first; this doc assumes its §-numbered concepts (`WorldSnapshot`, `WorldSource`, `WorldCommands`, `LayoutStrategy`, `SkinMap`, the event→world reducer).
> Author seed: design consult, 2026-05-30.

## 1. What this is

The **embodied** variant of Diorama. Where `GAME_BRIDGE.md`'s observer mode is a god's-eye dashboard-as-world you click into, **Town Mode** is a world you *inhabit*: you drive an avatar that represents **you**, walk a procedurally-generated town that **is** your AgentRoom, walk up to an agent standing outside its house, and **talk to it** — by text or by voice.

The pitch in one line: **Gather.town × Stardew Valley / Animal Crossing, where the residents are your live agents.** 2D pixel sprites, top-down, single-player.

The motivating moment, end to end: you walk up to a clanker standing by its house with a "!" over its head; it turns to face you and says — in its own voice — *"hey, I'm stuck on the auth migration, A or B?"*; you answer out loud; it nods, walks back to its desk, and gets to work. Every piece of that is real: the "!" is a real `human_escalation`, the speech is a real `message.posted`, your answer is a real `runtime/input`, and "gets to work" is a real `Agent.state` transition.

## 2. The one thing to internalize: Town Mode is additive and client-side

**Town Mode introduces zero `packages/core` domain changes.** The daemon SSE
route from `GAME_BRIDGE.md §9.1` is now part of the built API; everything else
new lives in the renderer/client:

- The **player avatar** is the first piece of world state with no backing `RoomEvent` — and that's fine. Its position is real-time input, purely local, ephemeral, and (single-player) seen by no one else. It never enters core, the event log, or the protocol. This is *more* defensible than agent positions, not less.
- **"Walk up and talk"** is the `GAME_BRIDGE.md §7` inspector, triggered by **proximity** instead of a **click**. Same `WorldCommands.sendInput`, same `runtime.output_observed` / `message.posted` stream.
- **Voice** is an **edge transform**: speech-to-text in, text-to-speech out. Text stays the protocol truth; audio never touches the backend.
- The **procedural town** is just a `ProceduralTownLayout implements LayoutStrategy` (`GAME_BRIDGE.md §4.4` made layout pluggable on purpose).

So the backend stays semantic; the inhabited world is *derived + locally-driven*. Consistent with the hard rule in `GAME_BRIDGE.md §3` and `agent-room/CLAUDE.md`'s provider-neutral, event-first model.

## 3. One world, two cameras

Observer Mode and Town Mode are two views over the **same** `WorldSnapshot`, `WorldSource`, and `WorldCommands`. They diverge only at three already-pluggable seams plus the new player/voice subsystems:

| Seam | Observer Mode (`GAME_BRIDGE.md §7`) | Town Mode (this doc) |
| --- | --- | --- |
| **Camera** | fixed god-view, free pan/zoom | follow-cam locked to the player avatar |
| **Input** | click/tap an entity | drive avatar (joystick/WASD) + proximity |
| **Layout** | floor-plan `LayoutStrategy` | `ProceduralTownLayout` |
| **Interaction** | click → inspector panel | walk up → dialogue box + voice |
| **Subsystems** | — | player controller, proximity, conversation, voice |

The renderer can host both and **toggle** at runtime (overview ⇄ walk-around) over one live snapshot. That makes Town Mode a strict superset of the observer renderer, not a fork.

## 4. Design principles (inherited + new)

Inherited from `GAME_BRIDGE.md`:
- **Presentation is client-only.** Position, animation, pathing, layout, *and now* avatar position, proximity, voice transcripts — none enter core or the event log.
- **Deterministic, no random/fallback** (`dev/CLAUDE.md`). The town is a **pure function of `(room topology, seed)`**. Same room → same town, every load, every device. The avatar's live position is the *only* non-derived state, and it's local + ephemeral.
- **Single-player.** Multiplayer co-presence (multiple humans sharing one mutable town) still forces a backend `presence`/`position` concept — deferred per `GAME_BRIDGE.md §10`.

New to Town Mode:
- **Voice is a transform, not a channel.** STT produces the same text `sendInput` already sends; TTS reads the same `message.posted` the dialogue box already shows. The protocol never learns voice exists.
- **No-fallback ≠ no-graceful-degradation.** If on-device STT is unavailable, fall back to the **text input box** (a capability check, not fabricated data). That's allowed; inventing fake agent dialogue is not.

## 5. The five new client subsystems

### 5.1 Player avatar & controller

```ts
// All client-only. Never serialized to the daemon.
interface PlayerState {
  id: 'player'                       // singleton; the human
  position: Vec2                     // world-space, real-time
  facing: Direction                  // 'n' | 'e' | 's' | 'w' (4-dir PoC)
  motion: 'idle' | 'walk'
  skin: PlayerSkinRef                // optional customization
}

interface PlayerController {
  // Input → intent. Keyboard/gamepad on web/desktop; on-screen joystick on iOS.
  setMoveAxis(axis: Vec2): void      // normalized [-1,1]; (0,0) = stop
  update(dtMs: number, collision: CollisionGrid): PlayerState  // integrate + resolve collisions
}
```

Spawn point is **deterministic** (the town entrance / plaza), not random and not persisted — reload puts you at the gate, consistent with the no-random rule. Movement is grid-aware top-down with collision against the town's `CollisionGrid` (§6). 4-direction for the PoC; 8-direction is an art+anim upgrade, not an architecture change.

### 5.2 Proximity & interaction system

```ts
type InteractionKind = 'talk-to-agent' | 'inspect-task' | 'enter-building' | 'read-sign'

interface Interactable {
  kind: InteractionKind
  targetId: Id                       // agent / object / building / room id
  anchor: Vec2                       // where the prompt floats
  radius: number                     // activation distance in world units
}

interface ProximitySystem {
  // Pure: recompute each frame from player + snapshot-derived interactables.
  nearest(player: PlayerState, interactables: Interactable[]): Interactable | null
  // Emits enter/exit so the renderer can show/hide the "press to talk" affordance.
  diff(prev: Interactable | null, next: Interactable | null): ProximityChange[]
}
```

Mapping: an **agent** in radius → `talk-to-agent`; a derived **work desk** in
radius → `inspect-task`; a **building door** → `enter-building` (post-PoC); a
**signboard** → `read-sign` (room/workspace label). The affordance is the
classic AC "press A / tap to interact" prompt over the target.

### 5.3 Conversation model (the heart of Town Mode)

A `ConversationSession` binds the player to **one** agent and is built entirely from existing primitives:

```ts
type ConversationPhase =
  | 'idle'        // standing nearby, no active turn
  | 'listening'   // capturing player voice/text
  | 'sent'        // input delivered to agent
  | 'acking'      // agent's immediate acknowledgement playing
  | 'thinking'    // agent working; "…" bubble
  | 'speaking'    // agent message rendering + TTS playing

interface ConversationTurn {
  from: 'player' | 'agent'
  text: string
  at: ISODateTime
  source: 'message' | 'input' | 'stt'   // provenance, for the transcript view
}

interface ConversationSession {
  agentId: Id
  phase: ConversationPhase
  transcript: ConversationTurn[]
  // outbound: player → agent (existing command)
  say(text: string): Promise<void>      // → WorldCommands.sendInput(agentId, text)
  // inbound is fed by the reducer from the live stream:
  //   message.posted (by agentId)        → 'speaking'  (spoken dialogue, TTS'd)
  //   runtime.output_observed (agentId)  → "their screen" detail view, NOT spoken
}
```

**The key modeling call — speech vs inner monologue:**

| Domain signal | Town Mode meaning | Surfaced as |
| --- | --- | --- |
| `message.posted` (from the agent) | what the agent **says out loud** | dialogue box text + TTS voice |
| `runtime.output_observed` | the agent's **inner monologue / screen** | optional "look at their computer" panel — **not** spoken |

Piping raw terminal stdout into a dialogue bubble would be ugly and verbose. Agents already emit clean, intentional `message.posted` — that *is* dialogue. Reserve the terminal scrollback for a deliberate "peek at their screen" action. This split falls out of the existing domain at zero cost.

**Turn-taking & latency (be honest):** an agent is an LLM doing real work, not a real-time chat partner. Conversations are **async**: immediate `acking` ("on it!") if the harness emits one, a `thinking` "…" bubble while work runs, then `speaking` as messages stream back — possibly seconds to minutes later. The UX must be built for replies that arrive **after** you've already walked away, so:
- A conversation **parks** into a small docked panel when you leave proximity; a late reply pings you with a waypoint back to that agent (§7).
- Never promise a phone-call cadence the agent can't honor.

### 5.4 Voice I/O adapter

```ts
interface VoiceProfile {
  // Per AgentRole, so each character sounds distinct. Lives in the SkinMap extension (§5.6).
  voiceId: string
  rate: number
  pitch: number
}

interface SttSession {
  start(mode: 'push-to-talk' | 'vad'): void   // PTT recommended for PoC (no false triggers)
  stop(): Promise<string>                       // final transcript
  onPartial(cb: (text: string) => void): void   // live caption while speaking
}

interface VoiceAdapter {
  stt(): SttSession
  // Returns audio playback + a stream for mouth-flap / viseme sync.
  speak(text: string, profile: VoiceProfile): Promise<TtsPlayback>
}

interface TtsPlayback {
  amplitudeAt(tMs: number): number   // drive 2-frame mouth-flap; visemes optional/post-PoC
  done: Promise<void>
}
```

Platform backends behind the same interface:

| Platform | STT | TTS |
| --- | --- | --- |
| **iOS 26 / iPhone 17 Pro** (target) | on-device `SpeechAnalyzer` / `SpeechTranscriber` | `AVSpeechSynthesizer` (+ Personal Voice opt-in) |
| **Web / desktop (Tauri)** | Web Speech API or a Whisper endpoint | Web `SpeechSynthesis` or a TTS endpoint |

On iOS the WebGL canvas runs in `WKWebView` (`GAME_BRIDGE.md §5` Option A), so the `VoiceAdapter` is the **one place Town Mode needs a small native shim**: a Swift ↔ JS bridge exposing on-device speech to the web bundle (mic permission, push-to-talk, transcript callback; text → `AVSpeechSynthesizer`). On-device STT is also the privacy story — your voice never leaves the phone; only the resulting text reaches the agent over the existing authenticated `/v1/runtime/.../input` route.

### 5.5 Procedural town layout

```ts
// Implements GAME_BRIDGE.md §4.4 LayoutStrategy. Deterministic; seeded by room topology.
interface ProceduralTownLayout extends LayoutStrategy {
  generate(world: WorldSnapshot, seed: TownSeed): TownPlan
}

type TownSeed = string               // e.g. stableHash(roomId) [+ optional user salt]; NEVER a clock/RNG

interface TownPlan {
  districts: District[]              // one per Workspace / channel
  roads: RoadGraph                   // walkable connections between districts + plaza
  plaza: Rect                        // spawn / town center (default channel)
  collision: CollisionGrid           // baked walkability for movement + pathfinding
}

interface District {
  roomId: Id                         // ← Workspace / channelId
  bounds: Rect
  lots: Lot[]                        // reserved building plots (see §6 stability rule)
}

interface Lot {
  index: number                      // deterministic slot within the district
  position: Vec2
  occupantId: Id | null              // agentId once assigned; null = reserved/empty
  building: BuildingSkinRef          // house/shop skin by role
}
```

See §6 for the algorithm and the critical stability rule.

### 5.6 SkinMap extension

Town Mode extends `GAME_BRIDGE.md §4.3`'s `SkinMap`:

```ts
interface TownSkinMap extends SkinMap {
  playerSkin: PlayerSkinRef
  roleVoices: Record<AgentRole, VoiceProfile>      // distinct voice per role
  roleBuildings: Record<AgentRole, BuildingSkinRef> // each role's house/shop
  townTheme: { exteriorTileset: TilesetRef; props: PropSetRef }  // grass/path/water/trees/fences/signs
}
```

## 6. Town generation in detail

**Seeding.** `TownSeed = stableHash(roomId)` (optionally `+ userSalt` so a person can reroll *their own* view without affecting the canonical mapping). Never seed from a clock or RNG — `Date.now()`/`Math.random()` are banned here both by `dev/CLAUDE.md` and by the determinism requirement.

**Domain → town mapping:**

| AgentRoom domain | Town element |
| --- | --- |
| `Workspace` / `channelId` | a **district / neighborhood** |
| default channel | the central **plaza** (player spawn) |
| `Agent` | a **resident** standing by its **house/shop** (skin by `role`) |
| external tracker work / event `taskId` refs | **yard object / signboard** at the owner's lot; derived status → skin |
| `handoff.created` / `delegation.created` | a resident **walks the road** to another's lot, carrying an item |
| `Agent.state` | body language at the lot (idle/typing/alert/wave/celebrate/slump) |
| `human_escalation` / `approval.requested` | a **beacon** over the lot + a town-wide **waypoint** (§7) |

**Algorithm (recommended for PoC — lot-subdivision, *not* Wave Function Collapse):**
1. Partition the map into district zones (BSP or a fixed grid), one zone per workspace, ordered by a stable key (workspace id sort) so districts are positionally stable.
2. Within each district, **reserve a deterministic sequence of lots** (e.g. a seeded but fixed spiral/grid of plots), independent of how many agents currently exist.
3. Lay **roads** connecting district centers to the plaza (simple Manhattan/grid routing for the PoC; an L-system is a later polish).
4. **Bake** the `CollisionGrid` (buildings, water, fences = blocked; grass, paths = walkable).

> **Skip WFC for the PoC.** It produces gorgeous organic tile-towns but is painful to constrain ("this building *must* be workspace X") and unstable under incremental change. It's a v2 aesthetic upgrade, not a foundation.

**The critical rule — incremental stability.** When an agent joins or a workspace appears, you must **not** regenerate and reshuffle existing buildings. Use **additive, id-keyed lot assignment**:

```
assignLot(agentId, district):
  # stable, order-independent: same agent always claims the same lot,
  # regardless of arrival order or who else exists.
  slot = stableHash(agentId) mod district.lots.length
  resolve collisions by deterministic linear probe (slot+1, slot+2, …)
  occupy district.lots[slot]
```

This guarantees: (a) a given agent is always at the same address across sessions; (b) adding agent N+1 never moves agents 1..N; (c) it's a pure function of ids, so every client computes the identical town. Reserve more lots than current occupancy so growth has room without re-partitioning. If a district overflows its reserved lots, append a new lot row deterministically (still additive — existing lots keep their positions).

**Pathfinding.** Grid **A\*** over the `CollisionGrid` powers handoff walks (resident → resident) and optional player tap-to-walk. Deterministic tie-breaking (prefer lower-index neighbor) keeps replays identical.

## 7. Interaction & dialogue UX

Animal-Crossing grammar:
- **Approach** → "press to talk" prompt floats over the agent.
- **Engage** → dialogue box docks at the bottom; agent text reveals typewriter-style with soft bleeps; if voice is on, TTS plays in the role's voice with a 2-frame mouth-flap.
- **Respond** → three affordances: (1) **mic** (push-to-talk → STT → `say()`), (2) **text field**, (3) **quick-command chips** mapped to `WorldCommands` — `approve`, `stop`, `delegate`, "show me your screen" (opens the terminal panel).
- **Leave** → conversation parks to a docked mini-panel; you can walk off mid-task.

**Finding who needs you.** `needs-human` / `blocked` agents raise a **beacon** (tall "!" visible across the town) and register a **waypoint marker** at the screen edge pointing toward their lot — so escalations are discoverable without panning a map. This is the embodied analog of the observer mode's "wave at the player." The escalation queue literally becomes *a set of lit beacons you can walk to*.

## 8. Rendering & camera

- **Follow-cam** with a dead-zone, snapping to the avatar; **zoom-out toggle** flips to the observer-style overview (same snapshot, §3).
- **Top-down tile renderer** with painter's-order z-sorting (entities sorted by world-y); PixiJS, per `GAME_BRIDGE.md §5` Option A.
- **60 fps tweening** for motion, but remember the **data rate is human-paced** (events every few seconds) — no netcode/rollback needed; the SSE + tween loop is more than enough. Don't over-engineer toward "real-time multiplayer game" infrastructure.
- Optional ambiance: day/night tint driven by **real wall-clock** *for display only* (never fed back into logic — it must not affect the deterministic layout).

## 9. Asset delta (on top of `GAME_BRIDGE.md` asset workflow)

The sprite pipeline is unchanged (`game-asset-pipeline`: locked palette/seed → Aseprite spritesheet + JSON, frame-tags named to match the animation enum). Town Mode **adds**:
- **Player avatar**: 4-direction walk + idle (the "you" character; optional customization).
- **Agents**: for the PoC keep them **stationary, facing the player** (huge art/pathing savings); 4-dir roaming is a later upgrade.
- **Exterior town tileset** (the big new lift): grass, paths, water, trees, fences, houses/shops by role, signboards — generate as a coherent set, then **hand-fix tiling seams in Aseprite/Tiled** (AI tilesets always need edge cleanup).
- **AC dialogue UI**: bottom text box, typewriter, "press to talk" prompt, thinking "…" bubble, "!" beacon, edge waypoint marker.
- **Per-role TTS `VoiceProfile`** config (data, not art).

(If you ever want a talking-head **video portrait** of an agent in the "look at their screen" panel, `dev/ft-gen` — the persona / lip-sync / audio-speech system — is the tool. Out of scope for the 2D PoC.)

## 10. What changes in the ecosystem

1. **Daemon:** nothing beyond `GAME_BRIDGE.md §9.1`'s one SSE route. No new endpoints for Town Mode.
2. **New package:** `@agentroom/diorama-town` — `PlayerController`, `ProximitySystem`, `ConversationSession`, `VoiceAdapter` (with web + iOS backends), `ProceduralTownLayout`, `TownSkinMap`. Depends on `@agentroom/diorama-core`.
3. **iOS:** one small **native speech bridge** (Swift ↔ JS in `WKWebView`) for on-device STT/TTS. The rest of the canvas is the shared web bundle from `GAME_BRIDGE.md §9.4`.
4. **No core/domain/event-schema changes. No SQLite requirement.** (Replay performance note from `GAME_BRIDGE.md §9.5` still applies but isn't needed for MVP.)

## 11. Suggested phasing

1. **Spike — inhabitable town.** Static tile town generated from real workspaces/agents; drop the player avatar; walk + collision. Proves embodiment on live room data.
2. **Text dialogue.** Proximity → AC dialogue box bound to one agent: `message.posted` in, `sendInput` out. **No voice yet.**
3. **Procedural layout, properly.** `ProceduralTownLayout` with deterministic seeding + the §6 incremental-stability rule; handoff walk paths via A\*.
4. **Voice layer.** `VoiceAdapter` — STT in, TTS out, per-role voices, mouth-flap. iOS native speech bridge.
5. **Polish.** Escalation beacons + waypoints; overview-camera toggle; **embodied replay** (walk your town *while scrubbing a recorded day* — falls out of `GAME_BRIDGE.md §8`).

The reducer (events → world) and the `ProceduralTownLayout` determinism (same ids → same town) are the two invariants worth a focused test, per `CLAUDE.md` testing philosophy. Everything else is presentation in flux.

## 12. Open questions / decisions for you

1. **Perspective & directions:** top-down 4-dir (simplest) vs ¾ iso vs 8-dir (more art/anim). Recommend 4-dir top-down for the PoC.
2. **Agents: roam or stay put?** Stationary-facing-player is far cheaper and reads fine. Roaming is a polish upgrade.
3. **Building interiors vs all-exterior.** PoC: agents stand outside their houses; no interiors.
4. **Where conversations live when you walk away** — parked docked panel (recommended) vs hard-end.
5. **Push-to-talk vs always-on VAD.** Recommend PTT (no false triggers, clearer turn-taking).
6. **Town generation algorithm:** lot-subdivision (recommended) vs template-stamp vs WFC (defer).
7. **Player customization** — fixed avatar vs pick-a-skin.
8. **Does replay support embodied walking?** (It can — confirm it's in scope for phase 5.)
9. **Names.** Town Mode / Diorama / Clankton all placeholders.

## 13. Domain → Town quick reference

| AgentRoom domain (`packages/core/src/domain.ts`) | Town Mode |
| --- | --- |
| `Workspace` / `channelId` | district / neighborhood; default channel = plaza |
| `Agent` + `role` | resident + house/shop skin |
| `Agent.state` (`idle`/`working`/`waiting`/`blocked`/`needs-human`/`reviewing`/`done`/`failed`) | resident body language at the lot |
| external tracker work / event `taskId` refs | yard object/signboard at the lot; derived status → skin |
| `message.posted` (from agent) | **spoken dialogue** → dialogue box + TTS |
| `runtime.output_observed` | **inner monologue / their screen** → optional panel, not spoken |
| `runtime/input` (command) | what you **say** to a resident (typed or STT'd) |
| `handoff.created` / `delegation.created` | resident walks the road carrying an item |
| `human_escalation` / `approval.requested` | beacon over the lot + town-wide waypoint |
| `RuntimeBinding` | which machine the resident's house "runs on" (flavor) |
| *(player avatar)* | **you** — client-only, never in core |

---

### Appendix: key references

- Framework + protocol + observer mode: **`GAME_BRIDGE.md`** (this folder)
- Domain & states: `agent-room/packages/core/src/domain.ts`
- Events / cursor primitive (SSE basis): `agent-room/packages/core/src/services/AgentRoomService.ts`
- Daemon REST (commands; SSE route lives here): `agent-room/apps/daemon/src/app.ts`
- iOS client contract to mirror: `agent-room-ios/SwarmiOS/Services/AgentRoomAPIClient.swift`
- Architecture principles (event-first, provider-neutral): `agent-room/docs/ARCHITECTURE.md`
- Sprite/tileset asset pipeline: `dev/game-asset-pipeline` (reference → identity → frames → Aseprite spritesheet)
- Optional video-portrait persona tooling: `dev/ft-gen` (persona / lip-sync / audio-speech) — post-PoC only
- Prior-art mechanics: Gather.town (proximity comms), Stardew Valley / Animal Crossing (cozy town, dialogue grammar)
