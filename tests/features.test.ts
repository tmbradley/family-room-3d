/**
 * iPhone app features end to end through the HTTP API and MCP:
 *  - photos: linked to the scan import made with the same code and to its room; signed URLs (short-lived)
 *    for the session and read-scope agents; tags/notes; backfill SQL for photos from before migration 0005
 *  - templates: synced library, parameter validation, scanned object -> closest template, furnish-from-scan
 *  - placement params and room colors are change-engine entities (revisions, rollback, Current locked)
 *  - measurement suggestions from the phone become proposals that only Michael approves
 *  - Object Capture models: placement-scoped code, upload, attach as a revision, same-origin file proxy
 *  - new MCP tools by scope; propose tools only create pending proposals
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';

// A tiny in-memory S3 (path-style PUT/GET) so uploads and the model proxy run for real, offline.
const objects = new Map<string, Buffer>();
let s3srv: Server;
await new Promise<void>((resolve) => {
  s3srv = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0]);
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c)).on('end', () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { etag: '"x"' }).end(); });
    } else if (req.method === 'GET' && objects.has(key)) res.writeHead(200, { 'content-length': objects.get(key)!.length }).end(objects.get(key));
    else res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
  }).listen(0, '127.0.0.1', () => resolve());
});
process.env.S3_ENDPOINT = `http://127.0.0.1:${(s3srv!.address() as any).port}`;
process.env.S3_FORCE_PATH_STYLE = '1';

const { prisma, prepareTestDb } = await import('./helpers.js');
const { seedHouse } = await import('../server/seed.js');
const { app } = await import('../server/app.js');
const { sha256 } = await import('../server/util.js');
const { syncTemplates, checkParam, matchTemplate, TEMPLATES } = await import('../server/templates.js');
const { editorRotation, parseCapturedRoom, unmirrorObjects } = await import('../server/scans.js');
// @ts-ignore plain JS module
const { buildCapturedRoom, SAMPLE } = await import('../fixtures/roomplan-builder.mjs');

const SESSION = 'michael-features-session';
const READ_KEY = 'hp_read_features_test';
const PROPOSE_KEY = 'hp_propose_features_test';
let W = 0, draftRoom = 0, draftSofa = 0;

type Who = 'michael' | 'read' | 'agent' | 'none';
async function http(method: string, path: string, body?: unknown, who: Who = 'michael', raw?: Uint8Array) {
  const headers: Record<string, string> = { 'content-type': raw ? 'application/octet-stream' : 'application/json' };
  if (who === 'michael') headers.cookie = `hp_session=${SESSION}`;
  if (who === 'read') headers.authorization = `Bearer ${READ_KEY}`;
  if (who === 'agent') headers.authorization = `Bearer ${PROPOSE_KEY}`;
  const res = await app.request(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null; try { json = JSON.parse(buf.toString()); } catch { json = buf; }
  return { status: res.status, json, headers: res.headers };
}
const ok = (r: { status: number; json: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };
const mcp = async (key: string, name: string, args: any = {}) => {
  const res = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? 'tools/list' : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }) });
  const body: any = await res.json();
  if (name === 'tools/list') return body.result.tools.map((t: any) => t.name).sort();
  const text = body.result.content[0].text;
  return { isError: !!body.result.isError, text, data: body.result.isError ? null : JSON.parse(text) };
};
const pair = async (b: any) => ok(await http('POST', '/api/upload-tokens', b), 201).token as string;
/** Presign, PUT the bytes to the signed URL (mock bucket), complete. */
async function upload(token: string, kind: string, format: string, bytes: Uint8Array, photo?: any) {
  const p = ok(await http('POST', '/api/uploads/presigned', { token, kind, format }, 'none'));
  const put = await fetch(p.url, { method: 'PUT', body: bytes, headers: { 'content-type': p.contentType } });
  assert.equal(put.status, 200);
  ok(await http('POST', `/api/uploads/${p.uploadId}/complete`, { token, bytes: bytes.byteLength, ...(photo ? { photo } : {}) }, 'none'));
  return p.uploadId as number;
}
const cost = { steps: [{ step: 'other', changes: 'n/a', lowUsd: 0, highUsd: 0 }] };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const USDZ = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9]);

before(async () => {
  await prepareTestDb();
  await seedHouse(prisma as any, {
    house: { name: 'Features test house' }, current: null,
    workspaces: [{ id: 'test', name: 'Test room', notes: 'fixture', rooms: [{
      id: 'den', label: 'Den', ceiling: 8, walls: [{ id: 'w1', a: [0, 0], b: [10, 0], height: 8 }], openings: [],
      furniture: [{ id: 'sofa', kind: 'sofa', name: 'Sofa', w: 84, d: 36, h: 32, x: 5, z: 3, rot: 0 }],
    }] }],
  });
  await prisma.$transaction((tx) => syncTemplates(tx as any), { timeout: 60_000 });
  W = (await prisma.workspace.findFirstOrThrow()).id;
  draftRoom = (await prisma.room.findFirstOrThrow()).id;
  draftSofa = (await prisma.placement.findFirstOrThrow()).id;
  const u = await prisma.user.create({ data: { name: 'Michael' } });
  await prisma.session.create({ data: { userId: u.id, tokenHash: sha256(SESSION), expiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.agentKey.create({ data: { name: 'features read', scope: 'read', prefix: 'hp_read_', keyHash: sha256(READ_KEY) } });
  await prisma.agentKey.create({ data: { name: 'features propose', scope: 'propose', prefix: 'hp_propose_', keyHash: sha256(PROPOSE_KEY) } });
});
after(async () => { await prisma.$disconnect(); s3srv.close(); });

test('templates: library synced idempotently, params validated, scanned objects map to the closest template', async () => {
  await prisma.$transaction((tx) => syncTemplates(tx as any), { timeout: 60_000 });
  const slugs = (await prisma.furnitureTemplate.findMany()).map((t) => t.slug).sort();
  assert.deepEqual(slugs, TEMPLATES.map((t) => t.slug).sort());
  for (const s of ['l_sectional', 'sofa', 'armchair', 'swivel_chair', 'coffee_table', 'side_table', 'media_console', 'rug', 'floor_lamp', 'bed', 'dresser', 'nightstand', 'desk', 'bookshelf']) assert.ok(slugs.includes(s), s);
  const list = ok(await http('GET', '/api/templates', undefined, 'read'));
  const sect = list.find((t: any) => t.slug === 'l_sectional');
  for (const k of ['armStyle', 'legStyle', 'legHeightIn', 'cushionCount', 'chaiseSide', 'seatDepthIn', 'fabricColor']) assert.ok(sect.params.some((p: any) => p.key === k), k);
  assert.equal((await http('GET', '/api/templates', undefined, 'none')).status, 401);
  assert.throws(() => checkParam('sofa', 'nope', '1'), /nope/);
  assert.throws(() => checkParam('l_sectional', 'chaiseSide', 'middle'));
  assert.throws(() => checkParam('sofa', 'legHeightIn', '500'));
  assert.equal(checkParam('sofa', 'fabricColor', '#AABBCC'), '#aabbcc');
  assert.equal(matchTemplate('sofa', 84, 36, 34)!.slug, 'sofa');
  assert.equal(matchTemplate('sofa', 112, 92, 34)!.slug, 'l_sectional');
  assert.equal(matchTemplate('table', 48, 24, 18)!.slug, 'coffee_table');
  assert.equal(matchTemplate('bed', 60, 80, 24)!.slug, 'bed');
  assert.equal(matchTemplate('storage', 70, 18, 22)!.slug, 'media_console');
  assert.equal(matchTemplate('toilet', 20, 28, 30), null);
  // Plan yaw (counterclockwise from +x, seen from above) is three.js rotation.y; squared to 90°.
  assert.equal(editorRotation(0), 0); assert.equal(editorRotation(90), 90); assert.equal(editorRotation(268), 270); assert.equal(editorRotation(181), 180); assert.equal(editorRotation(359), 0);
});

let scanId = 0, curRoom = 0, photoIds: number[] = [], scanToken = '';
test('photos: linked to the scan and its room through scan_photos, with notes, tags and short-lived signed URLs', async () => {
  scanToken = await pair({ newRoom: true, label: 'Family room' });
  const room = buildCapturedRoom(SAMPLE);
  const enc = new TextEncoder().encode(JSON.stringify(room));
  const json = await upload(scanToken, 'scan', 'roomplan_json', enc);
  await upload(scanToken, 'scan', 'usdz', USDZ);
  const p1 = await upload(scanToken, 'photo', 'jpg', JPEG, { prompt: 'Fireplace wall', note: 'Paint is chipped by the mantel', roomTag: 'Family room', tags: ['Fireplace', 'paint', 'paint', '<script>'] });
  await upload(scanToken, 'photo', 'jpg', JPEG, { prompt: 'Outlets', tags: ['outlets'] });
  // Not linked to any scan yet: only to the (still unknown) room.
  assert.equal((await prisma.scanPhoto.count({ where: { scanImportId: { not: null } } })), 0);
  const labels = { [room.objects[0].identifier]: 'Gray three-seat sofa, 84 in wide\u0007' };
  const si = ok(await http('POST', '/api/scans/import', { token: scanToken, uploadId: json, roomplanData: room, objectLabels: labels }, 'none'), 201);
  scanId = si.id;
  const rows = await prisma.scanPhoto.findMany({ include: { tags: true }, orderBy: { id: 'asc' } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.scanImportId === scanId && r.roomId === null));
  assert.deepEqual(rows[0].tags.map((t) => t.tag).sort(), ['fireplace', 'paint', 'script']);
  assert.equal(rows[0].uploadId, p1);
  photoIds = rows.map((r) => r.id);
  // The USDZ is filed with the scan too.
  assert.equal(await prisma.upload.count({ where: { scanImportId: scanId } }), 4); // JSON, USDZ and both photos
  const review = ok(await http('GET', `/api/scans/${scanId}`, undefined, 'read'));
  assert.equal(review.photos.length, 2);
  assert.match(review.photos[0].url, /X-Amz-Expires=600/);
  assert.match(review.photos[0].url, /X-Amz-Signature=/);
  assert.equal(review.photos[0].note, 'Paint is chipped by the mantel');
  const sofa = review.parsed.objects.find((o: any) => o.kind === 'sofa');
  assert.equal(sofa.template.slug, 'sofa');
  assert.equal(sofa.label, 'Gray three-seat sofa, 84 in wide');
  assert.equal(review.parsed.objects.find((o: any) => o.kind === 'table').template.slug, 'coffee_table');
  assert.equal(review.canFurnish, false);
  // Promote: the photos get the new Current room.
  ok(await http('POST', `/api/scans/${scanId}/promote`));
  curRoom = (await prisma.scanImport.findUniqueOrThrow({ where: { id: scanId } })).roomId!;
  assert.ok((await prisma.scanPhoto.findMany()).every((r) => r.roomId === curRoom));
  // Readers (session and read-scope agent keys) get signed URLs; signed out gets nothing.
  assert.equal((await http('GET', `/api/photos?roomId=${curRoom}`, undefined, 'none')).status, 401);
  const viaRead = ok(await http('GET', `/api/photos?roomId=${curRoom}`, undefined, 'read'));
  assert.equal(viaRead.length, 2);
  assert.equal(viaRead[0].urlExpiresInSeconds, 600);
  assert.equal((await http('GET', '/api/photos', undefined, 'read')).status, 400);
  // The signed URL works against the bucket and returns the photo bytes.
  const got = await fetch(viaRead[0].url);
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), JPEG);
  const tool = await mcp(READ_KEY, 'list_room_photos', { roomId: curRoom });
  assert.equal(tool.data.length, 2);
  assert.match(tool.data[1].url, /X-Amz-Signature=/);
  const gs = await mcp(READ_KEY, 'get_scan_import', { scanImportId: scanId });
  assert.equal(gs.data.photos.length, 2); assert.equal(gs.data.preview, undefined);
});

test('photo backfill (migration 0005) links pre-existing photo uploads to their scan and room, once', async () => {
  const t = await prisma.uploadToken.findFirstOrThrow({ where: { tokenHash: { not: '' } }, orderBy: { id: 'asc' } });
  const u = await prisma.upload.create({ data: { houseId: (await prisma.house.findFirstOrThrow()).id, tokenId: t.id, kind: 'photo', format: 'jpg', bucketKey: 'scans/x/old.jpg', status: 'uploaded', uploadedBy: 'michael' } });
  const sql = readFileSync('prisma/migrations/0005_photos_templates_models/migration.sql', 'utf8');
  const insert = sql.slice(sql.indexOf('INSERT INTO `scan_photos`')).replace(/;\s*$/, '');
  await prisma.$executeRawUnsafe(insert);
  await prisma.$executeRawUnsafe(insert);
  const rows = await prisma.scanPhoto.findMany({ where: { uploadId: u.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scanImportId, scanId);
  assert.equal(rows[0].roomId, curRoom);
  await prisma.scanPhoto.delete({ where: { id: rows[0].id } });
  await prisma.upload.delete({ where: { id: u.id } });
});

let furnWs = 0;
test('furnish from scan: Michael only; template placements in a new workspace linking Current; rollback removes them', async () => {
  assert.equal((await http('POST', `/api/scans/${scanId}/furnish`, {}, 'agent')).status, 403);
  const r = ok(await http('POST', `/api/scans/${scanId}/furnish`, { name: 'Family room furniture' }), 201);
  furnWs = r.workspaceId;
  assert.equal(r.placements, 2);
  const ws = ok(await http('GET', `/api/workspaces/${furnWs}`, undefined, 'read'));
  const room = ws.rooms.find((x: any) => x.id === curRoom);
  assert.ok(room, 'the workspace links the Current room');
  const sofa = room.furniture.find((f: any) => f.template?.slug === 'sofa');
  assert.ok(sofa, JSON.stringify(room.furniture));
  assert.equal(sofa.item.name, 'Gray three-seat sofa, 84 in wide');
  assert.equal(sofa.template.params.cushionCount, '3');
  assert.equal(sofa.xIn, 72); assert.equal(sofa.yIn, 120);
  const params = await prisma.placementParam.count({ where: { placement: { workspaceId: furnWs } } });
  assert.ok(params >= 1);
  // Current is untouched.
  assert.equal(await prisma.placement.count({ where: { workspaceId: null } }), 0);
  ok(await http('POST', `/api/workspaces/${furnWs}/rollback`, { toRevision: 0 }));
  assert.equal(await prisma.placement.count({ where: { workspaceId: furnWs } }), 0);
  assert.equal(await prisma.placementParam.count({ where: { placement: { workspaceId: furnWs } } }), 0);
  ok(await http('POST', `/api/workspaces/${furnWs}/rollback`, { toRevision: 1 }));
  assert.equal(await prisma.placement.count({ where: { workspaceId: furnWs } }), 2);
  assert.equal(await prisma.placementParam.count({ where: { placement: { workspaceId: furnWs } } }), params);
  // A rescan of an existing room is in a different frame and can't be furnished.
  const re = await pair({ roomId: curRoom });
  const room2 = buildCapturedRoom(SAMPLE);
  const j = await upload(re, 'scan', 'roomplan_json', new TextEncoder().encode('{}'));
  const s2 = ok(await http('POST', '/api/scans/import', { token: re, uploadId: j, roomplanData: room2 }, 'none'), 201);
  assert.equal((await http('POST', `/api/scans/${s2.id}/furnish`, {})).json.error, 'cannot_furnish');
  ok(await http('POST', `/api/scans/${s2.id}/reject`, {}));
});

test('placement params and room colors: validated revisions, rollback-able, Current locked', async () => {
  const ws = ok(await http('GET', `/api/workspaces/${furnWs}`, undefined, 'read'));
  const rev = ws.revision;
  const sofa = ws.rooms.find((x: any) => x.id === curRoom).furniture.find((f: any) => f.template?.slug === 'sofa');
  const sofaTpl = (await prisma.furnitureTemplate.findUniqueOrThrow({ where: { slug: 'sofa' } })).id;
  const save = (baseRevision: number, changes: any[]) => http('POST', `/api/workspaces/${furnWs}/changes`, { baseRevision, changes });
  assert.equal((await save(rev, [{ op: 'create', entityType: 'placement_param', fields: { placementId: sofa.id, key: 'legHeightIn', value: '999' } }])).status, 400);
  assert.equal((await save(rev, [{ op: 'create', entityType: 'placement_param', fields: { placementId: sofa.id, key: 'cushionCount', value: '2' } }])).status, 409);
  assert.equal((await save(rev, [{ op: 'create', entityType: 'placement_param', fields: { placementId: draftSofa, key: 'armStyle', value: 'track' } }])).status, 403); // another workspace's placement
  const s1 = ok(await save(rev, [
    { op: 'create', entityType: 'placement_param', fields: { placementId: sofa.id, key: 'armStyle', value: 'track' } },
    { op: 'create', entityType: 'room_style', fields: { roomId: curRoom, wallColorName: 'Chantilly Lace', wallColor: '#F4F3EE', trimColor: '#ffffff' } },
  ]));
  const v = ok(await http('GET', `/api/workspaces/${furnWs}`, undefined, 'read'));
  const room = v.rooms.find((x: any) => x.id === curRoom);
  assert.equal(room.furniture.find((f: any) => f.id === sofa.id).template.params.armStyle, 'track');
  assert.equal(room.style.wallColorName, 'Chantilly Lace');
  assert.equal(room.style.wallColor, '#f4f3ee');
  assert.equal((await save(s1.revision, [{ op: 'create', entityType: 'room_style', fields: { roomId: curRoom, wallColor: '#000000' } }])).status, 409);
  // Deleting the placement takes its params; rollback brings both back.
  const before = await prisma.placementParam.count({ where: { placementId: sofa.id } });
  const s2 = ok(await save(s1.revision, [{ op: 'delete', entityType: 'placement', entityId: sofa.id }]));
  assert.equal(await prisma.placementParam.count({ where: { placementId: sofa.id } }), 0);
  ok(await http('POST', `/api/workspaces/${furnWs}/rollback`, { toRevision: s1.revision }));
  assert.equal(await prisma.placementParam.count({ where: { placementId: sofa.id } }), before);
  assert.ok(s2.revision > s1.revision);
  // Changing the template on the workspace's own draft sofa works; Current still refuses furniture.
  ok(await http('POST', `/api/workspaces/${W}/changes`, { baseRevision: (await prisma.workspace.findUniqueOrThrow({ where: { id: W } })).revision, changes: [{ op: 'update', entityType: 'placement', entityId: draftSofa, field: 'templateId', value: sofaTpl }] }));
  assert.equal(await prisma.roomStyle.count({ where: { workspaceId: furnWs } }), 1);
});

test('measurement suggestions from the phone: a pending proposal; only Michael approves; values recorded as measured', async () => {
  const outline = ok(await http('POST', '/api/upload-tokens/room', { token: scanToken }, 'none'));
  assert.equal(outline.roomId, curRoom);
  const op = outline.openings.find((o: any) => o.type === 'window');
  const draftOpening = await prisma.opening.findFirst({ where: { wall: { roomId: draftRoom } } });
  // Entities outside the token's room are refused (and don't count against the limit).
  const wallElsewhere = await prisma.wall.findFirstOrThrow({ where: { roomId: draftRoom } });
  assert.equal((await http('POST', '/api/suggestions', { token: scanToken, notes: 'x', method: 'manual', suggestions: [{ entityType: 'wall', entityId: wallElsewhere.id, field: 'heightIn', valueIn: 96 }] }, 'none')).json.error, 'not_in_room');
  assert.equal((await http('POST', '/api/suggestions', { token: scanToken, notes: 'x', method: 'manual', suggestions: [{ entityType: 'opening', entityId: op.id, field: 'type', valueIn: 1 }] }, 'none')).json.error, 'not_measurable');
  void draftOpening;
  const p = ok(await http('POST', '/api/suggestions', { token: scanToken, notes: 'Window is 61 wide', method: 'on_device_model', suggestions: [{ entityType: 'opening', entityId: op.id, field: 'widthIn', valueIn: 61, note: 'tape' }] }, 'none'), 201);
  assert.equal(p.status, 'pending'); assert.equal(p.kind, 'measurements');
  assert.equal((await prisma.opening.findUniqueOrThrow({ where: { id: op.id } })).widthIn, op.widthIn);
  assert.equal((await http('GET', `/api/proposals/${p.id}/preview`, undefined, 'read')).json.error, 'no_preview');
  assert.equal((await http('POST', `/api/proposals/${p.id}/approve`, {}, 'agent')).status, 403);
  ok(await http('POST', `/api/proposals/${p.id}/approve`, {}));
  assert.equal((await prisma.opening.findUniqueOrThrow({ where: { id: op.id } })).widthIn, 61);
  const m = await prisma.measurement.findFirstOrThrow({ where: { entityType: 'opening', entityId: op.id, field: 'widthIn' }, orderBy: { id: 'desc' } });
  assert.equal(m.source, 'measured'); assert.equal(m.valueIn, 61);
  // At most five batches per code.
  for (let i = 0; i < 4; i++) ok(await http('POST', '/api/suggestions', { token: scanToken, notes: 'n', method: 'keywords', suggestions: [{ entityType: 'opening', entityId: op.id, field: 'widthIn', valueIn: 60 }] }, 'none'), 201);
  assert.equal((await http('POST', '/api/suggestions', { token: scanToken, notes: 'n', method: 'keywords', suggestions: [{ entityType: 'opening', entityId: op.id, field: 'widthIn', valueIn: 60 }] }, 'none')).status, 429);
});

test('Object Capture models: placement code, upload, attach as a revision, same-origin file; editor upload is Michael-only', async () => {
  const ws = ok(await http('GET', `/api/workspaces/${furnWs}`, undefined, 'read'));
  const sofa = ws.rooms.find((x: any) => x.id === curRoom).furniture.find((f: any) => f.template?.slug === 'sofa');
  assert.equal((await http('POST', '/api/upload-tokens', { placementId: sofa.id }, 'agent')).status, 403);
  const code = await pair({ placementId: sofa.id });
  const info = ok(await http('POST', '/api/upload-tokens/validate', { token: code }, 'none'));
  assert.equal(info.purpose, 'model'); assert.equal(info.placementId, sofa.id);
  assert.equal((await http('POST', '/api/uploads/presigned', { token: code, kind: 'scan', format: 'roomplan_json' }, 'none')).json.error, 'wrong_purpose');
  assert.equal((await http('POST', '/api/uploads/presigned', { token: scanToken, kind: 'model', format: 'usdz' }, 'none')).status, 401);
  const up = await upload(code, 'model', 'usdz', USDZ);
  const r = ok(await http('POST', '/api/models/import', { token: code, uploadId: up, label: 'Our sofa' }, 'none'), 201);
  assert.equal((await prisma.placement.findUniqueOrThrow({ where: { id: sofa.id } })).modelId, r.modelId);
  assert.equal((await http('POST', '/api/models/import', { token: code, uploadId: up }, 'none')).status, 401);
  const view = ok(await http('GET', `/api/workspaces/${furnWs}`, undefined, 'read')).rooms.find((x: any) => x.id === curRoom).furniture.find((f: any) => f.id === sofa.id);
  assert.equal(view.model.fileUrl, `/api/models/${r.modelId}/file`);
  assert.equal(view.model.source, 'object_capture');
  const file = await http('GET', view.model.fileUrl, undefined, 'read');
  assert.equal(file.status, 200);
  assert.deepEqual(new Uint8Array(file.json), USDZ);
  assert.equal(file.headers.get('content-type'), 'model/vnd.usdz+zip');
  assert.equal((await http('GET', view.model.fileUrl, undefined, 'none')).status, 401);
  // Rollback removes the attachment like any other change.
  const hist = ok(await http('GET', `/api/workspaces/${furnWs}/history`, undefined, 'read'));
  ok(await http('POST', `/api/workspaces/${furnWs}/rollback`, { toRevision: hist[0].number - 1 }));
  assert.equal((await prisma.placement.findUniqueOrThrow({ where: { id: sofa.id } })).modelId, null);
  // Editor upload (GLB) is Michael-only and checks the file type.
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
  assert.equal((await http('POST', `/api/models?format=glb&label=Chair`, undefined, 'agent', glb)).status, 403);
  assert.equal((await http('POST', `/api/models?format=glb&label=Chair`, undefined, 'michael', USDZ)).json.error, 'invalid_model');
  const g = ok(await http('POST', `/api/models?format=glb&label=Chair&placementId=${sofa.id}`, undefined, 'michael', glb), 201);
  assert.equal((await prisma.placement.findUniqueOrThrow({ where: { id: sofa.id } })).modelId, g.modelId);
  assert.equal((await http('GET', `/api/models/${g.modelId}/file`, undefined, 'read')).headers.get('content-type'), 'model/gltf-binary');
});

test('MCP: new read tools for read keys; propose tools create pending proposals only; Michael approves', async () => {
  const readTools = await mcp(READ_KEY, 'tools/list');
  for (const t of ['list_room_photos', 'get_scan_import', 'list_templates', 'list_models']) assert.ok(readTools.includes(t), t);
  for (const t of ['propose_colors', 'propose_furniture_template', 'propose_attach_model', 'create_proposal']) assert.ok(!readTools.includes(t), t);
  const tpl = await mcp(READ_KEY, 'list_templates');
  assert.ok(tpl.data.length >= 14);
  const models = await mcp(READ_KEY, 'list_models');
  assert.equal(models.data.length, 2);
  const ws = ok(await http('GET', `/api/workspaces/${furnWs}`, undefined, 'read'));
  const sofa = ws.rooms.find((x: any) => x.id === curRoom).furniture.find((f: any) => f.template?.slug === 'sofa');
  const base = { workspaceId: furnWs, rationale: 'From the photos', source: { kind: 'bot' }, cost };
  const styleBefore = await prisma.roomStyle.findFirstOrThrow({ where: { workspaceId: furnWs } });
  const c = await mcp(PROPOSE_KEY, 'propose_colors', { ...base, roomId: curRoom, wall: { name: 'Swiss Coffee', color: '#EFEBE1' }, devices: { name: 'Lutron white', color: '#ffffff' }, photoIds });
  assert.equal(c.isError, false, c.text);
  assert.equal(c.data.status, 'pending');
  assert.deepEqual(c.data.photos.map((p: any) => p.id).sort(), [...photoIds].sort());
  assert.equal((await prisma.roomStyle.findUniqueOrThrow({ where: { id: styleBefore.id } })).wallColor, styleBefore.wallColor);
  const bad = await mcp(PROPOSE_KEY, 'propose_furniture_template', { ...base, placementId: sofa.id, template: 'l_sectional', params: { chaiseSide: 'middle' } });
  assert.equal(bad.isError, true);
  const t = await mcp(PROPOSE_KEY, 'propose_furniture_template', { ...base, placementId: sofa.id, template: 'l_sectional', params: { chaiseSide: 'left', armStyle: 'track' } });
  assert.equal(t.isError, false, t.text);
  const a = await mcp(PROPOSE_KEY, 'propose_attach_model', { ...base, placementId: sofa.id, modelId: null });
  assert.equal(a.isError, false, a.text);
  assert.equal(await prisma.proposal.count({ where: { status: 'pending', id: { in: [c.data.id, t.data.id, a.data.id] } } }), 3);
  assert.equal((await http('POST', `/api/proposals/${c.data.id}/approve`, {}, 'agent')).status, 403);
  ok(await http('POST', `/api/proposals/${c.data.id}/approve`, {}));
  const st = await prisma.roomStyle.findUniqueOrThrow({ where: { id: styleBefore.id } });
  assert.equal(st.wallColorName, 'Swiss Coffee'); assert.equal(st.wallColor, '#efebe1'); assert.equal(st.deviceColor, '#ffffff');
  ok(await http('POST', `/api/proposals/${t.data.id}/approve`, {}));
  const pl = await prisma.placement.findUniqueOrThrow({ where: { id: sofa.id }, include: { template: true, params: true } });
  assert.equal(pl.template!.slug, 'l_sectional');
  assert.equal(pl.params.find((p) => p.key === 'chaiseSide')!.value, 'left');
  assert.ok(!pl.params.some((p) => p.key === 'cushionCount' && !TEMPLATES.find((x) => x.slug === 'l_sectional')!.params.some((q) => q.key === 'cushionCount')));
  // Read keys can't propose.
  const ro = await app.request('/api/proposals', { method: 'POST', headers: { authorization: `Bearer ${READ_KEY}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ro.status, 403);
});

test('mirror fix: older (frame 1) scans convert exactly; Michael-only, rollback-able; rescans wait for it', async () => {
  // Frame-1 parse of a room == frame-2 parse of its mirror image (z -> -z). unmirrorObjects undoes it.
  const room = buildCapturedRoom({ ...SAMPLE, yawDeg: 17, objects: [{ cat: 'sofa', x: 30, z: 20, w: 84, h: 34, d: 36 }, { cat: 'table', x: 100, z: 120, w: 48, h: 18, d: 24 }] });
  const mirror = JSON.parse(JSON.stringify(room));
  for (const list of ['walls', 'doors', 'windows', 'openings', 'objects', 'floors']) for (const o of mirror[list]) for (const i of [2, 6, 8, 9, 14]) o.transform[i] = -o.transform[i];
  const v2 = parseCapturedRoom(room), legacy = parseCapturedRoom(mirror);
  assert.notDeepEqual(legacy.objects.map((o) => o.yIn), v2.objects.map((o) => o.yIn));
  const fixed = unmirrorObjects(legacy);
  for (const [i, o] of v2.objects.entries()) {
    assert.ok(Math.abs(fixed[i].xIn - o.xIn) <= 1 && Math.abs(fixed[i].yIn - o.yIn) <= 1, JSON.stringify([fixed[i], o]));
    assert.equal(editorRotation(fixed[i].rotationDeg), editorRotation(o.rotationDeg));
  }
  // A Current room marked as built from a frame-1 scan.
  const legacyRoom = await prisma.room.findUniqueOrThrow({ where: { id: curRoom }, include: { walls: { orderBy: { id: 'asc' } } } });
  await prisma.room.update({ where: { id: curRoom }, data: { planFrame: 1 } });
  const re = await pair({ roomId: curRoom });
  const j = await upload(re, 'scan', 'roomplan_json', new TextEncoder().encode('{}'));
  const s2 = ok(await http('POST', '/api/scans/import', { token: re, uploadId: j, roomplanData: buildCapturedRoom(SAMPLE) }, 'none'), 201);
  assert.equal((await http('POST', `/api/scans/${s2.id}/promote`)).json.error, 'mirrored_room');
  assert.equal((await http('POST', `/api/scans/${scanId}/furnish`, {})).json.error, 'mirrored_room');
  assert.equal((await http('POST', `/api/rooms/${curRoom}/fix-mirror`, {}, 'agent')).status, 403);
  assert.equal((await http('POST', `/api/rooms/${curRoom}/fix-mirror`)).json.error, 'has_furniture'); // the furnished workspace
  const placed = await prisma.placement.findMany({ where: { roomId: curRoom } });
  await prisma.placementParam.deleteMany({ where: { placementId: { in: placed.map((p) => p.id) } } });
  await prisma.placement.deleteMany({ where: { roomId: curRoom } });
  assert.equal((await http('POST', `/api/rooms/${curRoom}/fix-mirror`)).json.error, 'pending_scans');
  ok(await http('POST', `/api/scans/${s2.id}/reject`, {}));
  const fx = ok(await http('POST', `/api/rooms/${curRoom}/fix-mirror`));
  assert.ok(fx.changeRows > 1);
  const after = await prisma.room.findUniqueOrThrow({ where: { id: curRoom }, include: { walls: { orderBy: { id: 'asc' } } } });
  const maxY = Math.max(...legacyRoom.walls.flatMap((w) => [w.startYIn, w.endYIn]));
  assert.equal(after.planFrame, 2);
  for (const [i, w] of after.walls.entries()) { assert.equal(w.startYIn, maxY - legacyRoom.walls[i].startYIn); assert.equal(w.endXIn, legacyRoom.walls[i].endXIn); }
  assert.equal((await http('POST', `/api/rooms/${curRoom}/fix-mirror`)).json.error, 'not_mirrored');
  // Rollback puts it back exactly (frame marker included).
  ok(await http('POST', '/api/current/rollback', { toRevision: fx.revision - 1 }));
  const back = await prisma.room.findUniqueOrThrow({ where: { id: curRoom }, include: { walls: { orderBy: { id: 'asc' } } } });
  assert.equal(back.planFrame, 1);
  assert.deepEqual(back.walls.map((w) => [w.startYIn, w.endYIn]), legacyRoom.walls.map((w) => [w.startYIn, w.endYIn]));
});

test('AASA: /scan opens the full app via universal links; no App Clip entry', async () => {
  process.env.APPLE_TEAM_ID = 'Q3HHMS5MLX';
  const r = ok(await http('GET', '/.well-known/apple-app-site-association', undefined, 'none'));
  assert.equal(r.appclips, undefined);
  assert.deepEqual(r.applinks.details[0].appIDs, ['Q3HHMS5MLX.com.michaelbradley.houseplanner']);
  assert.equal(r.applinks.details[0].components[0]['/'], '/scan');
});
