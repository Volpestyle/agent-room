import { describe, expect, it } from 'vitest';
import { createDefaultAgentRoomConfig, formatAgentRoomConfig, parseAgentRoomConfig, withDefaultRuntime } from './index.js';

describe('AgentRoom config', () => {
  it('round-trips the default YAML config', () => {
    const config = createDefaultAgentRoomConfig({
      roomId: 'agent-room',
      roomName: 'AgentRoom',
      defaultRuntime: 'herdr',
      runtimeSession: 'agent-room'
    });

    expect(parseAgentRoomConfig(formatAgentRoomConfig(config))).toEqual(config);
  });

  it('can switch the configured default runtime', () => {
    const config = createDefaultAgentRoomConfig({ roomId: 'agent-room' });
    const updated = withDefaultRuntime(config, 'tmux');

    expect(updated.runtime.default).toBe('tmux');
    expect(updated.runtimes.tmux).toEqual(expect.objectContaining({ type: 'tmux' }));
  });

  it('defaults Herdr to the shared agentroom session and room workspace', () => {
    const config = createDefaultAgentRoomConfig({ roomId: 'my-project' });

    expect(config.runtimes.herdr).toEqual(
      expect.objectContaining({
        type: 'herdr',
        session: 'agentroom',
        layout: expect.objectContaining({
          workspace: 'my-project'
        })
      })
    );
    expect(config.runtimes.tmux).toEqual(expect.objectContaining({ sessionPrefix: 'my-project' }));
  });

  it('parses Herdr layout numbers and booleans from YAML', () => {
    const parsed = parseAgentRoomConfig(`room:
  id: agent-room

runtime:
  default: herdr

runtimes:
  herdr:
    type: herdr
    layout:
      mode: pane-grid
      workspace: agent-room
      panesPerTab: 3
      split: focused
      balance: false

storage:
  driver: jsonl
  path: .agentroom/events.jsonl
`);

    expect(parsed.runtimes.herdr).toEqual({
      type: 'herdr',
      layout: {
        mode: 'pane-grid',
        workspace: 'agent-room',
        panesPerTab: 3,
        split: 'focused',
        balance: false
      }
    });
  });
});
