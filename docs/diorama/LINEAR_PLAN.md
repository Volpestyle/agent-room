# Linear plan: Diorama — Town Mode (Clankton)

> Import-ready breakdown for the Linear project. Source designs: [`GAME_BRIDGE.md`](./GAME_BRIDGE.md), [`TOWN_MODE.md`](./TOWN_MODE.md).
> Status: **created in Linear 2026-05-30** — team **Vuhlp** (VUH), project [Diorama — Town Mode (Clankton)](https://linear.app/vuhlp/project/diorama-town-mode-clankton-382ad035cebf). 47 issues **VUH-148 → VUH-194**, 7 milestones, dependency relations wired. Plan codes (F1, T2, …) are prefixed in each issue title for cross-reference.

## Project

- **Name:** Diorama — Town Mode (Clankton)
- **Summary:** Embodied, walk-up-and-talk game surface over AgentRoom. You drive an avatar through a procedurally-generated town that *is* your room, walk up to live agents, and talk to them by text or voice. 2D pixel sprites, single-player, PixiJS-in-WebView. All additive/client-side — one new daemon SSE route, no core/protocol changes.
- **Docs:** link the two design docs above.
- **Milestones:** Phase 0–5 below + a parallel Assets workstream.

### Legend
- **Estimate** = points (Fibonacci 1/2/3/5/8).
- **Labels** (suggested): `daemon`, `diorama-core`, `diorama-town`, `renderer`, `pcg`, `voice`, `ios`, `assets`, `infra`, `test`, `docs`, `spike`.
- **Blocked by** = hard dependency (set as Linear issue relation).

---

## Phase 0 — Foundation (protocol + core) · prereq for everything

> From `GAME_BRIDGE.md §9/§11`. Town Mode rides on this; build it first.

- **F1 — Add `GET /v1/events/stream` SSE route to agentroomd** `[3]` `daemon`
  Wrap existing `eventCursor` / `listEventsFromCursor`; `?cursor=` query; `text/event-stream` of `RoomEvent`; reuse `/v1/*` bearer auth.
  *AC:* client subscribes with a cursor and receives events as they append; reconnect resumes from last cursor with **no gaps**; unauthorized requests rejected.

- **F2 — Scaffold `@agentroom/diorama-core` package** `[3]` `diorama-core`
  Strict TS, no `any`. Define `WorldSnapshot` / `WorldEntity` / `WorldObject` / `WorldRoom` / `WorldLink` / `WorldEffect`.
  *AC:* package builds + typechecks in the monorepo; types match `GAME_BRIDGE.md §4.2`.

- **F3 — Implement event→world reducer** `[5]` `diorama-core` · *blocked by F2*
  Consume the `RoomEvent` stream → maintain denormalized `WorldSnapshot` (cursor/clock).
  *AC:* feeding a recorded log yields a correct snapshot; idempotent on replay.

- **F4 — Reducer unit tests (events → world invariant)** `[3]` `diorama-core` `test` · *blocked by F3*
  The one stable test worth keeping per `CLAUDE.md`.
  *AC:* covers each domain state/event → snapshot transition; deterministic.

- **F5 — Define `LayoutStrategy` / `SkinMap` / `WorldCommands` / `WorldSource` interfaces** `[2]` `diorama-core` · *blocked by F2*
  *AC:* interfaces compile; documented; match `GAME_BRIDGE.md §4.3–4.5`.

- **F6 — SSE `WorldSource` adapter + command wrappers** `[3]` `diorama-core` · *blocked by F1, F5*
  `subscribe(cursor, onEvent)` over the SSE stream; `WorldCommands` wired to existing REST (`sendInput`/`launch`/`stop`/`delegate`/`post`/`resolveEscalation`).
  *AC:* live room events drive the reducer; a command round-trips to the daemon.

---

## Phase 1 — Inhabitable town spike

> Goal: walk an avatar around a town built from **real** room data. `TOWN_MODE.md §11.1`.

- **T1 — Scaffold `@agentroom/diorama-pixi` + `@agentroom/diorama-town`** `[2]` `renderer` `diorama-town`
- **T2 — Tile renderer + follow-cam (dead-zone)** `[5]` `renderer`
  *AC:* renders a tile map; camera tracks a target with a dead-zone; 60fps on device.
- **T3 — Static town from live workspaces/agents** `[3]` `diorama-town` `renderer` · *blocked by F6, T2*
  Spike-grade layout: one building per agent, grouped by workspace.
- **T4 — PlayerController + PlayerState (4-dir, joystick + WASD)** `[5]` `diorama-town` `renderer`
  *AC:* avatar moves from keyboard and on-screen joystick; idle/walk anim states.
- **T5 — CollisionGrid + collision resolution** `[3]` `diorama-town` · *blocked by T4*
- **T6 — 🎯 Milestone demo: walk a real-data town on a connected iPhone** `[2]` `spike` · *blocked by T3, T5*
  *AC:* end-to-end loop proven on device per `CLAUDE.md` iOS testing pref.

---

## Phase 2 — Text dialogue (walk up & talk)

> `TOWN_MODE.md §5.2–5.3, §7, §11.2`. No voice yet.

- **D1 — ProximitySystem + Interactable derivation** `[3]` `diorama-town` · *blocked by T5*
  Nearest interactable within radius; enter/exit diff.
- **D2 — "Press to talk" affordance UI** `[2]` `renderer` · *blocked by D1*
- **D3 — ConversationSession model (phase machine)** `[3]` `diorama-town` · *blocked by F3*
  `idle→listening→sent→acking→thinking→speaking`, bound to one `agentId`.
- **D4 — Inbound wiring: message = speech, terminal = inner monologue** `[3]` `diorama-town` · *blocked by D3*
  `message.posted` → dialogue text; `runtime.output_observed` → optional "their screen" panel (not spoken).
- **D5 — Outbound wiring: `say()` / text field → `sendInput`** `[2]` `diorama-town` · *blocked by D3, F6*
- **D6 — AC-style dialogue box (typewriter, "…" bubble, transcript)** `[5]` `renderer` · *blocked by D4, D5*
- **D7 — Quick-command chips (approve/stop/delegate/show-screen)** `[3]` `renderer` `diorama-town` · *blocked by D5*
- **D8 — Conversation parking + late-reply ping** `[3]` `diorama-town` `renderer` · *blocked by D6*
  Async turn-taking: a reply that arrives after you walk away parks + pings.

---

## Phase 3 — Procedural town layout

> `TOWN_MODE.md §5.5, §6, §11.3`. Deterministic; incremental stability is the hard part.

- **P1 — `ProceduralTownLayout` types + `TownSeed` (stableHash)** `[3]` `pcg` `diorama-town` · *blocked by F5*
  `TownPlan`/`District`/`Lot`/`RoadGraph`; seed from `hash(roomId)` — never a clock/RNG.
- **P2 — District partition (per-workspace, stable order) + lot reservation** `[5]` `pcg` · *blocked by P1*
- **P3 — Incremental-stability lot assignment + tests** `[5]` `pcg` `test` · *blocked by P2*
  Id-keyed, additive, linear-probe. *AC:* adding agent N+1 never moves agents 1..N.
- **P4 — Road routing + plaza + bake CollisionGrid** `[5]` `pcg` · *blocked by P2*
- **P5 — Grid A\* pathfinding (deterministic tie-break)** `[3]` `pcg` `diorama-town` · *blocked by P4*
- **P6 — Handoff/delegation walk animation (carry-item, desk→desk)** `[3]` `renderer` `diorama-town` · *blocked by P5*
- **P7 — Determinism test: same ids+seed → identical TownPlan** `[2]` `pcg` `test` · *blocked by P3, P4*

---

## Phase 4 — Voice layer

> `TOWN_MODE.md §5.4, §11.4`. Edge transform — text stays protocol truth.

- **V1 — `VoiceAdapter` interface (Stt/Tts/VoiceProfile)** `[2]` `voice` `diorama-town`
- **V2 — Web backend: Web Speech STT + SpeechSynthesis TTS** `[5]` `voice` `renderer` · *blocked by V1*
- **V3 — iOS native speech bridge (Swift↔JS in WKWebView)** `[8]` `voice` `ios` · *blocked by V1*
  On-device `SpeechAnalyzer`/`SpeechTranscriber` STT + `AVSpeechSynthesizer` TTS; mic permission; push-to-talk. Privacy: voice never leaves device.
- **V4 — `roleVoices` mapping in `TownSkinMap`** `[2]` `voice` `diorama-town` · *blocked by V1*
- **V5 — Wire voice into ConversationSession (PTT→STT→`say()`; message→TTS)** `[3]` `voice` `diorama-town` · *blocked by V2 or V3, D5*
- **V6 — Mouth-flap sync (2-frame, amplitude-driven)** `[3]` `voice` `renderer` · *blocked by V5*

---

## Phase 5 — Polish & shipping

> `TOWN_MODE.md §7–§11.5`.

- **X1 — Escalation beacons (needs-human/blocked → tall "!")** `[3]` `renderer` `diorama-town` · *blocked by D4*
- **X2 — Off-screen waypoint markers to escalations** `[3]` `renderer` · *blocked by X1*
- **X3 — Overview-camera toggle (walk ⇄ god view, same snapshot)** `[3]` `renderer` · *blocked by T2*
- **X4 — Embodied replay (scrub log, walk town during playback)** `[5]` `diorama-core` `renderer` · *blocked by F3, T6*
- **X5 — Theming/reskin guide (SkinMap/TownSkinMap docs)** `[2]` `docs`
- **X6 — Tauri desktop build wrapping the web bundle** `[3]` `infra` · *blocked by T6*
- **X7 — WKWebView host inside agent-room-ios (bridge token/settings)** `[5]` `ios` `infra` · *blocked by T6*

---

## Assets workstream (parallel to Phases 1–5)

> Implemented by **Sprite Forge** (`agents/sprite-forge`, agentic-first CLI + skill) — a clean rebuild, **superseding** `dev/game-asset-pipeline`. See **[`ASSETS.md`](./ASSETS.md)** for the A1–A7 → stage mapping, plus `TOWN_MODE.md §9` + `GAME_BRIDGE.md §4.3`. Candidate for the multi-agent generate+QA Workflow. (A1/A2 paths built in the vertical slice; A3/A5/A6 need the `animate` + `bg`/`tileset` stages.)

- **A1 — Style bible: lock palette, resolution, angle, outline, fixed seed** `[3]` `assets`
- **A2 — 7 role character identities** `[5]` `assets` · *blocked by A1*
- **A3 — Per-role animation sets (idle/walk/typing/thinking/alert/wave/celebrate/slump), Aseprite export w/ frame-tags = AnimationState enum** `[8]` `assets` · *blocked by A2*
- **A4 — Player avatar sprite (4-dir walk + idle)** `[3]` `assets` · *blocked by A1*
- **A5 — Exterior town tileset (grass/path/water/trees/fences/buildings/signs) + hand-fix seams** `[8]` `assets` · *blocked by A1*
- **A6 — Work-object/desk skins (planned/working/done) + FX (bubble/"!"/confetti/carry-item)** `[5]` `assets` · *blocked by A1*
- **A7 — Dialogue UI art (box, prompt, beacon, waypoint)** `[3]` `assets` · *blocked by A1*

---

## Rollup

| Phase | Issues | Points |
| --- | --- | --- |
| 0 — Foundation | 6 | 19 |
| 1 — Inhabitable spike | 6 | 20 |
| 2 — Text dialogue | 8 | 24 |
| 3 — Procedural town | 7 | 26 |
| 4 — Voice | 6 | 23 |
| 5 — Polish | 7 | 24 |
| Assets | 7 | 35 |
| **Total** | **47** | **171** |

## Linear Import Note

This plan has already been imported into Linear for the Vuhlp team as the
project linked at the top of this file. Keep this page as the local
cross-reference for phase codes, milestone structure, and acceptance criteria;
make durable status, ownership, and issue comments in Linear.
