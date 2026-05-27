# Milestones

A dated log of moments where the AgentRoom system did something end-to-end
that it could not do before. Each entry names the session, the artifacts
that prove it, and what is explicitly not yet wired.

## 2026-05-26 — Passive multi-pane dashboard over live Codex/Claude work

First session where a lead agent in the AgentRoom TUI produced an
accurate per-pane status across seven parallel runtime panes in one turn,
while real coding work landed on disk from agents running in those panes.

### Topology

- Operator: Clanky against the `agent-room` profile.
- Lead agent: `dashboard` (openai-codex / gpt-5.5), joining and rejoining
  across effort tiers (low → medium → xhigh) before producing the
  consolidated status read.
- Runtime: `herdr` provider, two workspaces.
  - `w652ad8185cafa2-1..6` — six panes (Vite docs server, idle pane,
    Claude on a Mermaid theme fix, the TUI itself, Codex on a duplicate
    ElevenLabs TTS root-cause, Codex on configuration contracts).
  - `w652c48cca32463-1` — `implementer-1` codex pane, joined at
    2026-05-27T03:53Z.

### What worked

- Single-turn fan-out: the dashboard issued seven `read_runtime_agent`
  calls in parallel and synthesized them into a per-pane status that
  matched ground truth in `events.jsonl`.
- Event pipeline healthy across the session window: `agent.joined`,
  `runtime.bound`, `agent.heartbeat`, `message.posted`, and
  `runtime.output_observed` all firing as expected; ~9k events tailed
  with no schema drift.
- Real artifacts produced by agents inside the observed panes:
  - `docs/CONFIGURATION.md` (commit `0262ffb`, "Expand AgentRoom
    dashboard and config surfaces").
  - `clanky-pi/docs/configuration.md` (commit `2e5c92b`, "Document
    Clanky configuration ownership").
  - Mermaid dark/light theme fix in `clanky-pi` (commit `7148f23`).
  - Evidence-backed root-cause writeup for the duplicate ElevenLabs TTS
    bug, produced in pane `w652ad8185cafa2-5` from `clankvox` buffer
    logs.

### What is explicitly not yet wired

- The drive half of the loop. During the session there were zero
  `runtime.input_sent` events to any bound pane; the agents in panes 5
  and 6 ran under direct user steering, not under dashboard dispatch.
  The single post-session `runtime.input_sent` event (`"hi"` to
  `operator`, 2026-05-27T00:46Z) is an input-path smoke test, not a
  programmatic dispatch.

### Known cracks observed in the same window

- Stale pane polling: `daemon.log` filled with `pane_not_found` for
  `w652aca9fd72f08-8` at 160-line read cadence. Pane should be dropped
  from the observer after two consecutive `pane_not_found` results.
- Herdr observer socket lookup wrong:
  `[herdr-observer] failed to start … ENOENT
/Users/jamesvolpe/.config/herdr/sessions/agent-room/herdr.sock`. Events
  still flow via CLI fallback, so this is silent degradation.
- Unrelated Vite import error in `clanky-pi/apps/docs/src/content.ts:3`
  (`../../../docs/demo.md?raw`) recycled into the room's output stream
  for ~30 minutes. Not an AgentRoom bug, but the room is faithfully
  logging it forever.

### Evidence

- `.agentroom/events.jsonl` (tail of session window).
- `.agentroom/daemon.log`.
- `.agentroom/clanky/profiles/operator/sessions/2026-05-26T02-19-17-411Z_019e6214-4a23-77b1-a719-a7af49533021.jsonl`.
- Output commits produced during the session: `0262ffb`, `2e5c92b`,
  `7148f23` (see Snapshot below for the repos and HEADs).

### Snapshot — restore points

Captured at the close of the session so a future human or agent can
check out the exact state of the system that produced this milestone.

| Repo                     | Path                                      | Branch               | HEAD                                       | Commit date               | Subject                                        |
| ------------------------ | ----------------------------------------- | -------------------- | ------------------------------------------ | ------------------------- | ---------------------------------------------- |
| AgentRoom                | `/Users/jamesvolpe/dev/agents/agent-room` | `main`               | `0262ffbc35bffbfffcf5bfcebde01593039d1142` | 2026-05-26 23:33:42 -0500 | Expand AgentRoom dashboard and config surfaces |
| clanky-pi (operator)     | `/Users/jamesvolpe/dev/agents/clanky-pi`  | `v2-vanilla`         | `34f2a3b8b7cdf50771d6bea83b703186b60ce2a0` | 2026-05-26 23:36:24 -0500 | Register configuration.md in docs content map  |
| herdr (runtime provider) | `/Users/jamesvolpe/dev/herdr`             | `feat/balance-panes` | `324b778fdbe1232b5e684a5c096bd79deac3c399` | 2026-05-25 02:36:40 -0500 | feat: expose tab balance command               |

Working-tree notes at snapshot time:

- `agent-room`: clean for session-critical files. Dirty diffs in
  `README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and the
  untracked `docs/MILESTONES.md` are this milestone-documentation pass
  itself, not session output.
- `clanky-pi`: uncommitted edits in
  `agents/clanky/src/agentDiscordVoice.ts`,
  `agents/clanky/src/voice/openAiRealtimeClient.ts`,
  `agents/clanky/src/voice/xAiRealtimeClient.ts`, and
  `agents/clanky/test/voice-smoke.ts` — work-in-progress on the
  duplicate-TTS bug from pane `w652ad8185cafa2-5`, not part of the
  milestone artifact.
- `herdr`: uncommitted edits in `CONFIGURATION.md`,
  `src/app/input/navigate.rs`, `src/detect.rs`. The herdr binary that
  the daemon was talking to during the session was whatever was last
  built locally; if exact reproduction matters, rebuild from
  `324b778` with the working tree clean, then re-apply these diffs
  only if the session symptoms (e.g. `pane_not_found` polling) need to
  be reproduced.

To restore to this snapshot:

```bash
git -C /Users/jamesvolpe/dev/agents/agent-room checkout 0262ffbc35bffbfffcf5bfcebde01593039d1142
git -C /Users/jamesvolpe/dev/agents/clanky-pi checkout 34f2a3b8b7cdf50771d6bea83b703186b60ce2a0
git -C /Users/jamesvolpe/dev/herdr     checkout 324b778fdbe1232b5e684a5c096bd79deac3c399
```

The room state itself (events, daemon log, clanky session log) lives
under `.agentroom/` in this repo and is not tracked by git; if you need
that side preserved, copy `.agentroom/` to a snapshot directory before
running any new sessions, since `events.jsonl` and `daemon.log` will
keep appending.
