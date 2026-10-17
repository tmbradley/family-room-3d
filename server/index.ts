import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { prisma } from './db.js';
import { auth, requireAuth, rpID, origin } from './auth.js';
import { getHouse, exportHouse } from './house.js';
import { runExport, scheduleNightlyExport } from './export.js';
import { bootstrap } from './bootstrap.js';

const app = new Hono<{ Variables: { auth: import('./auth.js').AuthInfo } }>();

app.use('*', secureHeaders({ contentSecurityPolicy: undefined, crossOriginEmbedderPolicy: false }));

app.get('/health', async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const houses = await prisma.house.count();
    return c.json({ ok: true, db: 'up', houses });
  } catch (e) {
    return c.json({ ok: false, db: 'down' }, 503);
  }
});

app.route('/auth', auth);

app.get('/api/me', requireAuth('read'), (c) => c.json(c.get('auth')));
app.get('/api/house', requireAuth('read'), async (c) => {
  const house = await getHouse();
  return house ? c.json(house) : c.json({ error: 'not_seeded' }, 404);
});
app.get('/api/export', requireAuth('read'), async (c) => c.json(await exportHouse()));
app.post('/api/export/run', requireAuth('admin'), async (c) => c.json(await runExport()));

// Pages
app.get('/login', serveStatic({ path: './server/public/login.html' }));
app.get('/login.js', serveStatic({ path: './server/public/login.js' }));

// The three.js editor (static, from the repo root). Only editor files are served.
for (const f of ['index.html', 'main.js', 'catalog.js', 'style.css']) {
  app.get(`/${f}`, serveStatic({ path: `./${f}` }));
}
app.get('/', serveStatic({ path: './index.html' }));
app.use('/screenshots/*', serveStatic({ root: './' }));

app.notFound((c) => c.json({ error: 'not_found' }, 404));

await bootstrap().catch((e) => console.error('[bootstrap] failed', e));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => console.log(`house-planner listening on :${port} (rpID ${rpID}, origin ${origin})`));
if (process.env.DISABLE_EXPORT_SCHEDULER !== '1') scheduleNightlyExport();
