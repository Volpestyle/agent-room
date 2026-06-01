# Diorama

Design docs for **Diorama** — a thin framework for building game-like UIs over the AgentRoom (and later Clanky) ecosystem, where live agent/room state is rendered as an animated, clickable world instead of a dashboard.

Status: **implementation started.** `@agentroom/diorama-core`,
`@agentroom/diorama-town`, and `@agentroom/diorama-pixi` now exist, and the
daemon exposes the SSE event stream these docs proposed. Names (Diorama /
Clankton / Town Mode) are still placeholders.

## Docs

- **[`GAME_BRIDGE.md`](./GAME_BRIDGE.md)** — the framework. Why AgentRoom is already a game backend (event-sourced; domain enums map 1:1 onto Sims mechanics), the **World Protocol** (SSE stream + `WorldSnapshot` + `WorldCommands`), the pluggable `LayoutStrategy` / `SkinMap` seams, cross-platform strategy (TS + PixiJS, wrapped for desktop/iOS), and **observer mode** (god's-eye, click-to-command). **Start here.**
- **[`TOWN_MODE.md`](./TOWN_MODE.md)** — the embodied variant. You drive an avatar of yourself through a procedurally-generated town that *is* your AgentRoom, walk up to agents, and talk to them by **text or voice**. Gather.town × Stardew/Animal Crossing. Same protocol as `GAME_BRIDGE.md` — different camera, input, and layout.
- **[`ASSETS.md`](./ASSETS.md)** — the asset pipeline. The Assets workstream (A1–A7) is built as **Sprite Forge** (`agents/sprite-forge`), an agentic-first CLI + skill, superseding `game-asset-pipeline`. Maps each asset ticket to a Sprite Forge stage.

## The relationship in one line

Both docs describe **one world** (the same `WorldSnapshot` derived from the
daemon's event stream) viewed two ways: **Observer Mode** (fixed camera, click)
and **Town Mode** (follow-cam, embodied avatar, walk-up-and-talk). Town Mode is
a strict superset of the observer renderer — it adds a player controller,
proximity, conversation, voice, and a procedural-town layout, all
**client-side**, with **no core domain changes**. The daemon SSE route is now
part of the built API.

## Key shared principle

The backend stays **semantic**; the world is **derived**. Spatial position, animation, skins, pathing, town layout, avatar position, and voice are all client-side presentation concerns — they never enter `packages/core` or the event log. The town is a **deterministic** function of `(room topology, seed)` (no random, no fallback), so every client computes the same world.
