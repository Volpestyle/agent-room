import { serve } from '@hono/node-server';
import { createAppWithLifecycle } from './app.js';

const port = Number(process.env.AGENTROOM_PORT ?? '4317');

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function startLifecycle(): ReturnType<typeof createAppWithLifecycle> {
  try {
    return createAppWithLifecycle();
  } catch (error) {
    console.error(`agentroomd failed to start: ${describeError(error)}`);
    process.exit(1);
  }
}

const { app, shutdown } = startLifecycle();

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

async function handleFatal(label: string, error: unknown): Promise<void> {
  console.error(`agentroomd ${label}: ${describeError(error)}`);
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await shutdown();
  } catch (shutdownError) {
    console.error(
      `agentroomd shutdown error: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
    );
  } finally {
    // Exit non-zero so a supervisor or `agent-room daemon start` can relaunch.
    process.exit(1);
  }
}

process.on('SIGTERM', (signal) => {
  void handleSignal(signal);
});
process.on('SIGINT', (signal) => {
  void handleSignal(signal);
});
process.on('uncaughtException', (error) => {
  void handleFatal('uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  void handleFatal('unhandled rejection', reason);
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
