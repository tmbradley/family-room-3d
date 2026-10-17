import { Hono, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { prisma } from './db.js';
import { auth, requireAuth, type AuthInfo } from './auth.js';
import { getHouse, exportHouse } from './house.js';
import { runExport } from './export.js';
import { ApiError } from './util.js';
import { getHistory, rollbackWorkspace, saveChanges, type Op } from './changes.js';
import { copyWorkspace, createBlankWorkspace, getRoomView, getWorkspaceView, listWorkspaces } from './workspaces.js';
import { approveProposal, createProposal, getProposal, listProposals, previewProposal, rejectProposal } from './proposals.js';
import { measurementHistory, recordMeasurement, unpin } from './measurements.js';
import { fieldReference } from './entities.js';
import { handleMcp } from './mcp.js';
import { 
  generateUploadToken, 
  validateUploadToken, 
  markTokenUsed, 
  generatePresignedUpload, 
  completeUpload 
} from './uploads.js';
import { 
  createScanImport, 
  getScanImport, 
  listScanImports, 
  promoteScanImport, 
  rejectScanImport,
  type CapturedRoom 
} from './scans.js';

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
  workspaceId: z.number().int(), entityType: z.string(), entityId: z.number().int(), field: z.string(),
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

// Upload tokens and pairing
app.post('/api/upload-tokens', read, michaelOnly, async (c) => {
  const body = z.object({ roomId: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
  const token = await generateUploadToken(body.roomId);
  return c.json(token, 201);
});

// Validate token (used by App Clip)
app.post('/api/upload-tokens/validate', async (c) => {
  const body = z.object({ token: z.string() }).parse(await c.req.json());
  const tokenRecord = await validateUploadToken(body.token);
  return c.json({
    valid: true,
    roomId: tokenRecord.roomId,
    expiresAt: tokenRecord.expiresAt,
  });
});

// Generate presigned upload URL (used by App Clip)
app.post('/api/uploads/presigned', async (c) => {
  const body = z.object({
    token: z.string(),
    kind: z.enum(['scan', 'photo']),
    format: z.enum(['usdz', 'glb', 'roomplan_json', 'jpg', 'heic', 'png']),
    scanImportId: z.number().int().optional(),
  }).parse(await c.req.json());

  const tokenRecord = await validateUploadToken(body.token);
  const house = await prisma.house.findFirst();
  if (!house) throw new ApiError(404, 'no_house', 'No house found');

  const presigned = await generatePresignedUpload({
    houseId: house.id,
    roomId: tokenRecord.roomId ?? undefined,
    kind: body.kind,
    format: body.format,
    scanImportId: body.scanImportId,
  });

  return c.json(presigned);
});

// Complete upload (used by App Clip)
app.post('/api/uploads/:id/complete', async (c) => {
  const body = z.object({
    token: z.string(),
    bytes: z.number().int(),
  }).parse(await c.req.json());

  await validateUploadToken(body.token);
  await completeUpload(id(c.req.param('id')), body.bytes);
  return c.json({ success: true });
});

// Mark token as used after all uploads complete
app.post('/api/upload-tokens/:id/complete', async (c) => {
  const body = z.object({ token: z.string() }).parse(await c.req.json());
  const tokenRecord = await validateUploadToken(body.token);
  await markTokenUsed(tokenRecord.id);
  return c.json({ success: true });
});

// Import scan from RoomPlan data
app.post('/api/scans/import', async (c) => {
  const body = z.object({
    token: z.string(),
    uploadId: z.number().int(),
    roomplanData: z.any(), // CapturedRoom JSON
    label: z.string().max(120).optional(),
    roomId: z.number().int().optional(),
  }).parse(await c.req.json());

  const tokenRecord = await validateUploadToken(body.token);
  const house = await prisma.house.findFirst();
  if (!house) throw new ApiError(404, 'no_house', 'No house found');

  const scanImport = await createScanImport({
    houseId: house.id,
    uploadId: body.uploadId,
    roomplanData: body.roomplanData as CapturedRoom,
    label: body.label,
    roomId: body.roomId ?? tokenRecord.roomId ?? undefined,
  });

  return c.json(scanImport, 201);
});

// Scan imports management
app.get('/api/scans', read, async (c) => {
  const house = await prisma.house.findFirst();
  if (!house) return c.json([]);
  
  const status = c.req.query('status') as any;
  const scans = await listScanImports(
    house.id,
    ['pending', 'promoted', 'rejected'].includes(status) ? status : undefined
  );
  return c.json(scans);
});

app.get('/api/scans/:id', read, async (c) => {
  const scan = await getScanImport(id(c.req.param('id')));
  return c.json(scan);
});

app.post('/api/scans/:id/promote', read, michaelOnly, async (c) => {
  const result = await promoteScanImport(id(c.req.param('id')), 'michael');
  return c.json(result);
});

app.post('/api/scans/:id/reject', read, michaelOnly, async (c) => {
  const body = z.object({ notes: z.string().max(1000).optional() }).parse(await c.req.json().catch(() => ({})));
  const result = await rejectScanImport(id(c.req.param('id')), body.notes);
  return c.json(result);
});

// MCP
app.all('/mcp', (c) => handleMcp(c.req.raw));

// Apple App Site Association for App Clip
app.get('/.well-known/apple-app-site-association', (c) => {
  c.header('Content-Type', 'application/json');
  return c.body(require('fs').readFileSync('./server/public/apple-app-site-association', 'utf-8'));
});
app.get('/apple-app-site-association', (c) => {
  c.header('Content-Type', 'application/json');
  return c.body(require('fs').readFileSync('./server/public/apple-app-site-association', 'utf-8'));
});

// Pages
app.get('/login', serveStatic({ path: './server/public/login.html' }));
app.get('/login.js', serveStatic({ path: './server/public/login.js' }));
for (const f of ['index.html', 'main.js', 'catalog.js', 'style.css', 'scene.js', 'api.js']) {
  app.get(`/${f}`, serveStatic({ path: `./${f}` }));
}
app.get('/', serveStatic({ path: './index.html' }));
app.use('/screenshots/*', serveStatic({ root: './' }));

app.notFound((c) => c.json({ error: 'not_found' }, 404));
