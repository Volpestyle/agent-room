import { describe, expect, it } from 'vitest';
import { FakeRuntimeProvider } from './index.js';

describe('FakeRuntimeProvider', () => {
  it('starts, reads, and sends to an agent', async () => {
    const runtime = new FakeRuntimeProvider();
    await runtime.startAgent({
      agentId: 'demo',
      roomId: 'room',
      role: 'implementer',
      harness: { kind: 'shell', command: 'bash' }
    });
    await runtime.sendInput({ agentId: 'demo', text: 'hello' });
    const output = await runtime.readAgent({ agentId: 'demo', lines: 10 });

    expect(output.text).toContain('hello');
  });
});
