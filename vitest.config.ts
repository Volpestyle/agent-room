import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agentroom/core': `${root}packages/core/src/index.ts`,
      '@agentroom/config': `${root}packages/config/src/index.ts`,
      '@agentroom/storage-memory': `${root}packages/storage-memory/src/index.ts`,
      '@agentroom/storage-jsonl': `${root}packages/storage-jsonl/src/index.ts`,
      '@agentroom/runtime-fake': `${root}packages/runtime-fake/src/index.ts`,
      '@agentroom/runtime-herdr': `${root}packages/runtime-herdr/src/index.ts`,
      '@agentroom/runtime-tmux': `${root}packages/runtime-tmux/src/index.ts`,
      '@agentroom/chat-discord': `${root}packages/integrations/chat-discord/src/index.ts`
    }
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node'
  }
});
