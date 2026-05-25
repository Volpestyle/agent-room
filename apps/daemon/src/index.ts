import { serve } from '@hono/node-server';
import { createAppWithLifecycle } from './app.js';

const port = Number(process.env.AGENTROOM_PORT ?? '4317');

const { app, shutdown } = createAppWithLifecycle();

let shuttingDown = false;
async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`agentroomd received ${signal}, shutting down chat gateways`);
  try {
    await shutdown();
  } catch (error) {
    console.error(`agentroomd shutdown error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', (signal) => {
  void handleSignal(signal);
});
process.on('SIGINT', (signal) => {
  void handleSignal(signal);
});

serve(
  {
    fetch: app.fetch,
    port,
    hostname: process.env.AGENTROOM_HOST ?? '127.0.0.1'
  },
  (info) => {
    console.log(`agentroomd listening on http://${info.address}:${info.port}`);
  }
);
