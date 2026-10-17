import { serve } from '@hono/node-server';
import { app } from './app.js';
import { rpID, origin } from './auth.js';
import { scheduleNightlyExport } from './export.js';
import { bootstrap } from './bootstrap.js';

await bootstrap().catch((e) => console.error('[bootstrap] failed', e));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => console.log(`house-planner listening on :${port} (rpID ${rpID}, origin ${origin})`));
if (process.env.DISABLE_EXPORT_SCHEDULER !== '1') scheduleNightlyExport();
