# Diorama — Asset Pipeline (Sprite Forge)

The Diorama **Assets workstream** (Linear A1–A7) is implemented by **Sprite Forge**, an
agentic-first asset-generation CLI.

> **Decision (2026-05-30):** the asset pipeline is a clean **rebuild** as Sprite Forge,
> *not* a reuse of `dev/game-asset-pipeline` (or `dev/ft-gen`). Those informed the design
> (multi-provider routing, video→frames animation, Aseprite export, magenta-key bg removal)
> but were each built for a different purpose. Sprite Forge is stage-by-stage and
> agent-driven by design. Earlier plan/doc references to `game-asset-pipeline` for assets are
> superseded by this.

- **Repo:** `agents/sprite-forge` (TypeScript). See its `README.md`.
- **Skill:** `sprite-forge` (symlinked into `~/.claude/skills`), teaches the loop.
- **Spine:** Replicate + a pixel-native model (`SPRITEFORGE_IMAGE_MODEL`, intentionally
  unset until a verified model is chosen — no fabricated defaults). Provider-agnostic core.

## Why agentic-first

Each pipeline stage is a discrete CLI command with `--json` output that writes inspectable
PNGs. An agent runs a stage, **Reads the contact sheet to see the result**, critiques, tweaks
the prompt/seed, regenerates, then approves — the human-in-the-loop UI (Diorama Assets panel)
wraps this same CLI later. `forge.json` is the readable source of truth between stages.

## A1–A7 → Sprite Forge stages

| Linear | Workstream item | Sprite Forge | Status |
| --- | --- | --- | --- |
| A1 | Style bible: palette, resolution, angle, outline, fixed seed | `sf style set`, `sf style hero`, `sf palette extract/set` | **built** (vertical slice) |
| A2 | 7 role character identities | `sf character add` + `sf character gen` → `view` → `approve` | **built** (vertical slice) |
| A3 | Per-role animation sets, Aseprite export w/ frame-tags = `AnimationState` | `sf animate` (video→frames / multi-pose) → `sf pack` | **pending** (broaden phase) |
| A4 | Player avatar (4-dir walk + idle) | `sf character` + `sf animate` | pending |
| A5 | Exterior town tileset (+ seam fix) | `sf bg` / `sf tileset` (seamless mode) | **pending** (net-new stage) |
| A6 | Object/desk skins + FX (bubble/!/confetti/carry) | `sf bg --kind prop` + `sf animate` | pending |
| A7 | Dialogue UI art (box, prompt, beacon, waypoint) | `sf bg --kind prop` (one-shot) | pending |

The vertical slice covers **A1 + A2** (style/palette/cohesion + base character generation,
view, critique, approve, palette-apply, pack). The **broaden phase** adds two stages:
`animate` (A3/A4/A6 — the frame generation game-asset-pipeline did via video→frames) and
`bg`/`tileset` (A5/A6/A7 — backgrounds/tilesets, which neither prior tool supported).

## How it feeds the renderer

`sf pack` emits a grid sprite sheet PNG + an Aseprite-style JSON atlas. The broaden-phase
`animate` stage will tag frames with the `AnimationState` enum from
[`GAME_BRIDGE.md` §4.3 (SkinMap)](./GAME_BRIDGE.md) so the Diorama renderer binds
`role → sheet` and `state → animation` directly — closing the loop from generation to game.

## Cohesion (the thing that makes a cast look like one game)

One fixed palette + one hero reference + one style preamble, applied across every asset
(`sf palette apply`). Deterministic seeds keep runs reproducible. No random, no fallback —
consistent with the Diorama principle that the world is a deterministic function of its inputs.
