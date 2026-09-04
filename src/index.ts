// Worker entry: API under /api, SPA assets everywhere else, cron via scheduled.
import { Hono } from 'hono';
import type { Env } from './types';
import { apiRoutes } from './routes';
import { mcpApp } from './mcp';
import { scheduled } from './scheduled';

const app = new Hono<{ Bindings: Env }>();

app.route('/api', apiRoutes);
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404)); // unknown API path: JSON, not HTML
app.route('/mcp', mcpApp); // remote MCP server (bearer-gated, stateless)
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw)); // SPA fallback (frontend built separately)

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
