import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}));

describe('TmuxRuntimeProvider', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
  });

  it('quotes harness command arguments for tmux shell commands', async () => {
    const { TmuxRuntimeProvider } = await import('./index.js');
    const provider = new TmuxRuntimeProvider({
      cli: 'tmux-test',
      sessionPrefix: 'room'
    });

    await provider.startAgent({
      agentId: 'agent/one',
      roomId: 'room',
      role: 'implementer',
      harness: {
        kind: 'shell',
        command: 'printf',
        args: ['hello world', "it's ok", '$(touch /tmp/pwned)']
      }
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('tmux-test');
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'new-session',
      '-d',
      '-s',
      'room_agent_one',
      '-c',
      process.cwd(),
      "printf 'hello world' 'it'\\''s ok' '$(touch /tmp/pwned)'"
    ]);
  });
});
