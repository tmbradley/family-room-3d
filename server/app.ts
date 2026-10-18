import { Hono, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { prisma } from './db.js';
import { auth, requireAuth, type AuthInfo } from './auth.js';
import { getHouse, exportHouse } from './house.js';
import { runExport } from './export.js';
import { ApiError } from './util.js';
import { getHistory, rollbackCurrent, rollbackWorkspace, saveChanges, type Op } from './changes.js';
import { copyWorkspace, createBlankWorkspace, getRoomView, getWorkspaceView, listWorkspaces } from './workspaces.js';
import { approveProposal, createProposal, getProposal, listProposals, previewProposal, rejectProposal } from './proposals.js';
import { measurementHistory, recordMeasurement, unpin } from './measurements.js';
import { fieldReference } from './entities.js';
import { handleMcp } from './mcp.js';
import { attachModel, completeUpload, describeToken, generateUploadToken, importModel, importScan, presignUpload, submitSuggestions, tokenRoomOutline, uploadModelFile } from './uploads.js';
import { furnishFromScan, getScanImport, listScanImports, promoteScanImport, rejectScanImport } from './scans.js';
import { listPhotos } from './photos.js';
import { listTemplates } from './templates.js';
import { getObject, signedGetUrl } from './storage.js';
import { suggestionSchema } from './proposals.js';
import { bodyLimit } from 'hono/body-limit';

type Env = { Variables: { auth: AuthInfo } };
export const app = new Hono<Env>();

app.use('*', secureHeaders({ contentSecurityPolicy: undefined, crossOriginEmbedderPolicy: false }));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.message, details: err.details }, err.status as any);
  if (err instanceof z.ZodError) return c.json({ error: 'invalid_input', message: 'Invalid input', issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: 'server_error', message: 'Something went wrong' }, 500);
});

app.get('/health', async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const houses = await prisma.house.count();
    return c.json({ ok: true, db: 'up', houses });
  } catch {
    return c.json({ ok: false, db: 'down' }, 503);
  }
});

app.route('/auth', auth);

/** Writes that change designs: only Michael's passkey session, never an agent key. */
const michaelOnly: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('auth')?.kind !== 'user') throw new ApiError(403, 'michael_only', 'Only Michael (signed in with a passkey) can do this. Agents can create proposals.');
  return next();
};
const read = requireAuth('read');
const id = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'invalid_id', 'Invalid id');
  return n;
};
const tx = <T>(fn: (t: any) => Promise<T>) => prisma.$transaction(fn, { timeout: 30_000 });

const opSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), entityType: z.string(), tempRef: z.string().max(40).optional(), fields: z.record(z.string(), z.any()) }),
  z.object({ op: z.literal('update'), entityType: z.string(), entityId: z.number().int(), field: z.string(), value: z.any() }),
  z.object({ op: z.literal('delete'), entityType: z.string(), entityId: z.number().int() }),
]);
const toOps = (changes: z.infer<typeof opSchema>[]): Op[] =>
  changes.map((c) => (c.op === 'update' ? { op: 'update', entityType: c.entityType, entityId: c.entityId, field: c.field, after: c.value } : (c as Op)));

app.get('/api/me', read, (c) => c.json(c.get('auth')));
app.get('/api/house', read, async (c) => {
  const house = await getHouse();
  return house ? c.json(house) : c.json({ error: 'not_seeded' }, 404);
});
app.get('/api/schema', read, (c) => c.text(fieldReference()));
app.get('/api/export', read, async (c) => c.json(await exportHouse()));
app.post('/api/export/run', requireAuth('admin'), async (c) => c.json(await runExport()));

// Workspaces
app.get('/api/workspaces', read, async (c) => c.json(await listWorkspaces(prisma)));
app.get('/api/workspaces/:id', read, async (c) => c.json(await getWorkspaceView(prisma, id(c.req.param('id')))));
app.post('/api/workspaces', read, michaelOnly, async (c) => {
  const b = z.object({ name: z.string().min(1).max(120), copyFromWorkspaceId: z.number().int().optional() }).parse(await c.req.json());
  const ws = await tx(async (t) => (b.copyFromWorkspaceId ? (await copyWorkspace(t, b.copyFromWorkspaceId, b.name, 'michael')).workspace : createBlankWorkspace(t, b.name)));
  return c.json(await getWorkspaceView(prisma, ws.id), 201);
});
app.post('/api/workspaces/:id/changes', read, michaelOnly, async (c) => {
  const b = z.object({ baseRevision: z.number().int(), note: z.string().max(500).optional(), changes: z.array(opSchema).min(1).max(500) }).parse(await c.req.json());
  const wsId = id(c.req.param('id'));
  const r = await tx((t) => saveChanges(t, wsId, b.baseRevision, toOps(b.changes), b.note));
  return c.json(r);
});
app.get('/api/workspaces/:id/history', read, async (c) => c.json(await getHistory(prisma, id(c.req.param('id')), Number(c.req.query('limit')) || 50)));
app.post('/api/workspaces/:id/rollback', read, michaelOnly, async (c) => {
  const b = z.object({ toRevision: z.number().int().min(0), note: z.string().max(500).optional() }).parse(await c.req.json());
  const wsId = id(c.req.param('id'));
  return c.json(await tx((t) => rollbackWorkspace(t, wsId, b.toRevision, b.note)));
});
app.get('/api/rooms/:id', read, async (c) => {
  const ws = c.req.query('workspaceId');
  return c.json(await getRoomView(prisma, id(c.req.param('id')), ws ? id(ws) : undefined));
});

// Proposals
app.get('/api/proposals', read, async (c) => {
  const status = c.req.query('status') as any;
  const ws = c.req.query('workspaceId');
  return c.json(await listProposals({ status: ['pending', 'approved', 'rejected'].includes(status) ? status : undefined, workspaceId: ws ? id(ws) : undefined }));
});
app.get('/api/proposals/:id', read, async (c) => c.json(await getProposal(id(c.req.param('id')))));
app.get('/api/proposals/:id/preview', read, async (c) => c.json(await previewProposal(id(c.req.param('id')))));
app.post('/api/proposals', requireAuth('propose'), async (c) => {
  const a = c.get('auth');
  const p = await createProposal(await c.req.json(), a.kind === 'user' ? { actor: 'michael' } : { actor: 'agent', agentKeyId: a.agentKeyId });
  return c.json(p, 201);
});
const noteBody = async (c: any) => z.object({ note: z.string().max(1000).optional() }).parse(await c.req.json().catch(() => ({})));
app.post('/api/proposals/:id/approve', read, michaelOnly, async (c) => c.json(await approveProposal(id(c.req.param('id')), (await noteBody(c)).note)));
app.post('/api/proposals/:id/reject', read, michaelOnly, async (c) => c.json(await rejectProposal(id(c.req.param('id')), (await noteBody(c)).note)));

// Measurements: enter a measured value, pin (source = manual), unpin.
const mBody = z.object({
  workspaceId: z.number().int().nullable(), entityType: z.string(), entityId: z.number().int(), field: z.string(),
  valueIn: z.number().int(), action: z.enum(['measured', 'pin']), note: z.string().max(500).optional(),
});
app.post('/api/measurements', read, michaelOnly, async (c) => {
  const b = mBody.parse(await c.req.json());
  return c.json(await tx((t) => recordMeasurement(t, { ...b, source: b.action === 'pin' ? 'manual' : 'measured', actor: 'michael' })));
});
app.post('/api/measurements/unpin', read, michaelOnly, async (c) => {
  const b = mBody.pick({ workspaceId: true, entityType: true, entityId: true, field: true }).parse(await c.req.json());
  return c.json(await tx((t) => unpin(t, b)));
});
app.get('/api/measurements', read, async (c) => c.json(await measurementHistory(prisma, c.req.query('entityType') ?? '', id(c.req.query('entityId') ?? ''))));

// Current: read-only except through promoted scans, measurements and rollbacks.
const houseId = async () => {
  const h = await prisma.house.findFirst({ orderBy: { id: 'asc' } });
  if (!h) throw new ApiError(404, 'not_seeded', 'No house');
  return h.id;
};
app.get('/api/current/history', read, async (c) => c.json(await getHistory(prisma, { currentOf: await houseId() }, Number(c.req.query('limit')) || 50)));
app.post('/api/current/rollback', read, michaelOnly, async (c) => {
  const b = z.object({ toRevision: z.number().int().min(1), note: z.string().max(500).optional() }).parse(await c.req.json());
  const h = await houseId();
  return c.json(await tx((t) => rollbackCurrent(t, h, b.toRevision, b.note)));
});

// Phone pairing (Michael's session creates the code; the iPhone app uses only the code).
app.post('/api/upload-tokens', read, michaelOnly, async (c) => {
  const b = z.object({ roomId: z.number().int().optional(), newRoom: z.boolean().optional(), label: z.string().max(120).optional(), placementId: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(await generateUploadToken(b), 201);
});
const tokenBody = z.object({ token: z.string().min(1).max(40) });
app.post('/api/upload-tokens/validate', async (c) => c.json(await describeToken(tokenBody.parse(await c.req.json()).token)));
app.post('/api/upload-tokens/room', async (c) => c.json(await tokenRoomOutline(tokenBody.parse(await c.req.json()).token)));
app.post('/api/uploads/presigned', async (c) => {
  const b = tokenBody.extend({ kind: z.enum(['scan', 'photo', 'model']), format: z.string().max(20) }).parse(await c.req.json());
  return c.json(await presignUpload(b.token, b.kind, b.format));
});
app.post('/api/uploads/:id/complete', async (c) => {
  const b = tokenBody.extend({
    bytes: z.number().int().min(0).max(2_000_000_000),
    photo: z.object({ prompt: z.string().max(120).optional(), note: z.string().max(1000).optional(), roomTag: z.string().max(60).optional(), tags: z.array(z.string().max(40)).max(20).optional() }).optional(),
  }).parse(await c.req.json());
  return c.json(await completeUpload(b.token, id(c.req.param('id')), b.bytes, b.photo));
});
app.post('/api/scans/import', bodyLimit({ maxSize: 20 * 1024 * 1024, onError: () => { throw new ApiError(413, 'too_large', 'Scan JSON is larger than 20 MB'); } }), async (c) => {
  const b = tokenBody.extend({ uploadId: z.number().int(), roomplanData: z.unknown(), roomId: z.number().int().nullable().optional(), objectLabels: z.record(z.string().max(100), z.string().max(200)).optional() }).parse(await c.req.json());
  return c.json(await importScan(b.token, b), 201);
});
app.post('/api/models/import', async (c) => {
  const b = tokenBody.extend({ uploadId: z.number().int(), label: z.string().max(160).optional() }).parse(await c.req.json());
  return c.json(await importModel(b.token, b), 201);
});
app.post('/api/suggestions', async (c) => {
  const b = tokenBody.extend({ notes: z.string().min(1).max(4000), method: z.enum(['on_device_model', 'keywords', 'manual']), suggestions: z.array(suggestionSchema).min(1).max(30) }).parse(await c.req.json());
  return c.json(await submitSuggestions(b.token, b), 201);
});

// Photos (signed URLs, valid a few minutes) and templates: any reader (session or agent key).
app.get('/api/photos', read, async (c) => {
  const roomId = c.req.query('roomId'), scanImportId = c.req.query('scanImportId');
  return c.json(await listPhotos({ roomId: roomId ? id(roomId) : undefined, scanImportId: scanImportId ? id(scanImportId) : undefined }));
});
app.get('/api/templates', read, async (c) => c.json(await listTemplates(prisma)));

// 3D models: the file is proxied (same origin, so the web viewer can load it without bucket CORS).
app.get('/api/models/:id', read, async (c) => {
  const m = await prisma.furnitureModel.findUnique({ where: { id: id(c.req.param('id')) }, include: { upload: true } });
  if (!m) throw new ApiError(404, 'not_found', 'Model not found');
  return c.json({ id: m.id, label: m.label, source: m.source, format: m.upload.format, bytes: m.upload.bytes, fileUrl: `/api/models/${m.id}/file`, downloadUrl: await signedGetUrl(m.upload.bucketKey, m.upload.format) });
});
app.get('/api/models/:id/file', read, async (c) => {
  const m = await prisma.furnitureModel.findUnique({ where: { id: id(c.req.param('id')) }, include: { upload: true } });
  if (!m) throw new ApiError(404, 'not_found', 'Model not found');
  const obj = await getObject(m.upload.bucketKey);
  const bytes = await obj.Body!.transformToByteArray();
  return c.body(bytes as any, 200, { 'content-type': m.upload.format === 'glb' ? 'model/gltf-binary' : 'model/vnd.usdz+zip', 'cache-control': 'private, max-age=300' });
});
app.post('/api/models', read, michaelOnly, bodyLimit({ maxSize: 200 * 1024 * 1024, onError: () => { throw new ApiError(413, 'too_large', 'Models must be under 200 MB'); } }), async (c) => {
  const q = z.object({ format: z.enum(['usdz', 'glb']), label: z.string().min(1).max(160), placementId: z.coerce.number().int().optional() }).parse(c.req.query());
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return c.json(await uploadModelFile({ bytes, ...q }), 201);
});
app.post('/api/placements/:id/model', read, michaelOnly, async (c) => {
  const b = z.object({ modelId: z.number().int().nullable() }).parse(await c.req.json());
  return c.json(await tx((t) => attachModel(t, id(c.req.param('id')), b.modelId, b.modelId == null ? 'Removed custom model' : `Attached model #${b.modelId}`)));
});

// Scan review (read for any signed-in reader; promote/reject only Michael).
app.get('/api/scans', read, async (c) => {
  const status = c.req.query('status') as any;
  return c.json(await listScanImports(await houseId(), ['pending', 'promoted', 'rejected'].includes(status) ? status : undefined));
});
app.get('/api/scans/:id', read, async (c) => c.json(await getScanImport(id(c.req.param('id')))));
app.post('/api/scans/:id/promote', read, michaelOnly, async (c) => c.json(await promoteScanImport(id(c.req.param('id')), 'michael')));
app.post('/api/scans/:id/furnish', read, michaelOnly, async (c) => {
  const b = z.object({ name: z.string().min(1).max(120).optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(await furnishFromScan(id(c.req.param('id')), b.name), 201);
});
app.post('/api/scans/:id/reject', read, michaelOnly, async (c) => {
  const b = z.object({ notes: z.string().max(1000).optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(await rejectScanImport(id(c.req.param('id')), b.notes));
});

// MCP
app.all('/mcp', (c) => handleMcp(c.req.raw));

// Apple App Site Association: /scan?token=... links open the House Planner app (universal links).
const getAppleAppSiteAssociation = () => {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) return { error: 'APPLE_TEAM_ID environment variable not set' };
  return {
    applinks: {
      details: [{ appIDs: [`${teamId}.com.michaelbradley.houseplanner`], components: [{ '/': '/scan', '?': { token: '?*' }, comment: 'Pairing link from the editor' }] }],
    },
  };
};

app.get('/.well-known/apple-app-site-association', (c) => {
  c.header('Content-Type', 'application/json');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(getAppleAppSiteAssociation());
});
app.get('/apple-app-site-association', (c) => {
  c.header('Content-Type', 'application/json');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(getAppleAppSiteAssociation());
});

// Pages
app.get('/login', serveStatic({ path: './server/public/login.html' }));
app.get('/login.js', serveStatic({ path: './server/public/login.js' }));
// Pairing link (https://<host>/scan?token=...): opens the iPhone app; this page is the fallback. Shows only the code.
app.get('/scan', serveStatic({ path: './server/public/scan.html' }));
app.get('/scan.js', serveStatic({ path: './server/public/scan.js' }));
for (const f of ['index.html', 'main.js', 'catalog.js', 'style.css', 'scene.js', 'api.js']) {
  app.get(`/${f}`, serveStatic({ path: `./${f}` }));
}
app.get('/', serveStatic({ path: './index.html' }));
app.use('/screenshots/*', serveStatic({ root: './' }));

app.notFound((c) => c.json({ error: 'not_found' }, 404));
