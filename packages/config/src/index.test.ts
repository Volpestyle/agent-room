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
});
