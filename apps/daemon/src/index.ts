import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.AGENTROOM_PORT ?? '4317');

serve(
  {
    fetch: createApp().fetch,
    port,
    hostname: process.env.AGENTROOM_HOST ?? '127.0.0.1'
  },
  (info) => {
    console.log(`agentroomd listening on http://${info.address}:${info.port}`);
  }
);
