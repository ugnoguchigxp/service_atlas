import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import api from './app.ts';
const app = new Hono();
// Keep API paths intact when forwarding.
app.all('/api/*', context => api.fetch(context.req.raw));
app.use('*', serveStatic({root: './dist-web'}));
app.get('*', serveStatic({path: './dist-web/index.html'}));
const port = Number(process.env.ATLAS_PORT ?? 4317);
serve({fetch: app.fetch, hostname: '127.0.0.1', port}, () => console.log(`Service Atlas: http://127.0.0.1:${port}`));
