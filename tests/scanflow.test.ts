/**
 * Phone pairing, scan import and Promote to Current, end to end through the HTTP API:
 *  - pairing codes: Michael-only to create, hashed, scoped, expire, bound to their uploads, spent on import
 *  - promote: Michael-only; one revision with change rows; matches walls/openings so ids and pins
 *    survive; every scanned value recorded as a measurement; rollback-able like workspaces
 *  - Current stays locked to editor saves and proposals
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
const { prisma, prepareTestDb } = await import('./helpers.js');
const { seedHouse } = await import('../server/seed.js');
const { app } = await import('../server/app.js');
const { sha256 } = await import('../server/util.js');
const { saveChanges, applyOps } = await import('../server/changes.js');
const { createProposal } = await import('../server/proposals.js');
const { recordMeasurement } = await import('../server/measurements.js');
// @ts-ignore plain JS module
const { buildCapturedRoom, SAMPLE } = await import('../fixtures/roomplan-builder.mjs');

const SESSION = 'michael-test-session-token';
const PROPOSE_KEY = 'hp_propose_scanflow_test';
let W = 0, draftRoom = 0;

type Who = 'michael' | 'agent' | 'none';
async function http(method: string, path: string, body?: unknown, who: Who = 'michael') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'michael') headers.cookie = `hp_session=${SESSION}`;
  if (who === 'agent') headers.authorization = `Bearer ${PROPOSE_KEY}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const pair = async (b: any) => { const r = await http('POST', '/api/upload-tokens', b); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.token as string; };
const presign = (token: string, kind = 'scan', format = 'roomplan_json') => http('POST', '/api/uploads/presigned', { token, kind, format }, 'none');
const complete = (token: string, id: number) => http('POST', `/api/uploads/${id}/complete`, { token, bytes: 1234 }, 'none');
const importScan = (token: string, uploadId: number, roomplanData: unknown, roomId?: number | null) =>
  http('POST', '/api/scans/import', { token, uploadId, roomplanData, ...(roomId !== undefined ? { roomId } : {}) }, 'none');
async function scanVia(token: string, room: unknown) {
  const p = await presign(token); assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal((await complete(token, p.json.uploadId)).status, 200);
  const i = await importScan(token, p.json.uploadId, room); assert.equal(i.status, 201, JSON.stringify(i.json));
  return i.json.id as number;
}

before(async () => {
  await prepareTestDb();
  await seedHouse(prisma as any, {
    house: { name: 'Scan test house' }, current: null,
    workspaces: [{ id: 'test', name: 'Test room', notes: 'fixture', rooms: [{
      id: 'den', label: 'Den', ceiling: 8,
      walls: [{ id: 'w1', a: [0, 0], b: [10, 0], height: 8 }],
      openings: [], furniture: [{ id: 'sofa', kind: 'sofa', name: 'Sofa', w: 84, d: 36, h: 32, x: 5, z: 3, rot: 0 }],
    }] }],
  });
  W = (await prisma.workspace.findFirstOrThrow()).id;
  draftRoom = (await prisma.room.findFirstOrThrow()).id;
  const u = await prisma.user.create({ data: { name: 'Michael' } });
  await prisma.session.create({ data: { userId: u.id, tokenHash: sha256(SESSION), expiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.agentKey.create({ data: { name: 'scan test propose', scope: 'propose', prefix: 'hp_propose_', keyHash: sha256(PROPOSE_KEY) } });
});
after(async () => { await prisma.$disconnect(); });

test('pairing codes: only Michael creates them; stored hashed; scope must be a Current room or a new room', async () => {
  assert.equal((await http('POST', '/api/upload-tokens', { newRoom: true, label: 'X' }, 'none')).status, 401);
  assert.equal((await http('POST', '/api/upload-tokens', { newRoom: true, label: 'X' }, 'agent')).status, 403);
  assert.equal((await http('POST', '/api/upload-tokens', {})).status, 400);
  assert.equal((await http('POST', '/api/upload-tokens', { roomId: draftRoom })).json.error, 'not_current');
  const token = await pair({ newRoom: true, label: 'Probe' });
  assert.match(token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const row = await prisma.uploadToken.findFirstOrThrow({ orderBy: { id: 'desc' } });
  assert.equal(row.tokenHash, sha256(token.replace(/-/g, '')));
  assert.ok(!JSON.stringify(row).includes(token));
  assert.ok(row.expiresAt.getTime() - Date.now() <= 60 * 60_000 + 1000);
  const v = await http('POST', '/api/upload-tokens/validate', { token: token.toLowerCase() }, 'none');
  assert.equal(v.status, 200); assert.equal(v.json.scope, 'new_room');
  assert.equal((await http('POST', '/api/upload-tokens/validate', { token: 'AAAA-BBBB-CCCC' }, 'none')).status, 401);
});

test('pairing codes are bound to their own uploads, limited, and spent on import', async () => {
  const a = await pair({ newRoom: true, label: 'Room A' });
  const b = await pair({ newRoom: true, label: 'Room B' });
  assert.equal((await presign(a, 'scan', 'jpg')).status, 400);
  const pa = await presign(a);
  assert.equal(pa.status, 200);
  assert.match(pa.json.url, /X-Amz-Signature=/);
  assert.equal((await prisma.upload.findUniqueOrThrow({ where: { id: pa.json.uploadId } })).tokenId, (await prisma.uploadToken.findFirstOrThrow({ where: { tokenHash: sha256(a.replace(/-/g, '')) } })).id);
  // Another code can't complete or import A's upload.
  assert.equal((await complete(b, pa.json.uploadId)).status, 403);
  assert.equal((await importScan(b, pa.json.uploadId, SAMPLE_ROOM)).status, 403);
  // Import before the upload is complete is refused.
  assert.equal((await importScan(a, pa.json.uploadId, SAMPLE_ROOM)).status, 409);
  assert.equal((await complete(a, pa.json.uploadId)).status, 200);
  assert.equal((await complete(a, pa.json.uploadId)).status, 409);
  assert.equal((await prisma.uploadToken.findFirstOrThrow({ where: { tokenHash: sha256(a.replace(/-/g, '')) } })).uploadCount, 1);
  // A photo upload can't be imported as a scan.
  const photo = await presign(a, 'photo', 'jpg');
  await complete(a, photo.json.uploadId);
  assert.equal((await importScan(a, photo.json.uploadId, SAMPLE_ROOM)).json.error, 'not_roomplan');
  // A new-room code can't be pointed at an existing room.
  assert.equal((await importScan(a, pa.json.uploadId, SAMPLE_ROOM, draftRoom)).json.error, 'wrong_room');
  // Garbage JSON is refused and doesn't spend the code.
  assert.equal((await importScan(a, pa.json.uploadId, { dimensions: [1, 2, 3] })).status, 400);
  const ok = await importScan(a, pa.json.uploadId, SAMPLE_ROOM);
  assert.equal(ok.status, 201);
  // Spent: everything with this code is now 401.
  assert.equal((await http('POST', '/api/upload-tokens/validate', { token: a }, 'none')).status, 401);
  assert.equal((await presign(a)).status, 401);
  // Expired codes are 401; the per-code file limit is enforced.
  await prisma.uploadToken.updateMany({ where: { tokenHash: sha256(b.replace(/-/g, '')) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await presign(b)).json.error, 'token_expired');
  const c = await pair({ newRoom: true, label: 'Room C' });
  await prisma.uploadToken.updateMany({ where: { tokenHash: sha256(c.replace(/-/g, '')) }, data: { uploadLimit: 1 } });
  assert.equal((await presign(c)).status, 200);
  assert.equal((await presign(c)).status, 429);
  // Clean up the review queue for the promote tests.
  await http('POST', `/api/scans/${ok.json.id}/reject`, { notes: 'test' });
});

const SAMPLE_ROOM = buildCapturedRoom(SAMPLE);
let roomId = 0;

test('promote: Michael only; creates Current as one rescan revision with change rows and scan measurements', async () => {
  const before = { placements: await prisma.placement.count(), draftWalls: await prisma.wall.count({ where: { roomId: draftRoom } }), ws: await prisma.workspace.findUniqueOrThrow({ where: { id: W } }) };
  const id = await scanVia(await pair({ newRoom: true, label: 'Family room' }), SAMPLE_ROOM);
  assert.equal((await http('POST', `/api/scans/${id}/promote`, undefined, 'none')).status, 401);
  assert.equal((await http('POST', `/api/scans/${id}/promote`, undefined, 'agent')).status, 403);
  assert.equal((await prisma.house.findFirstOrThrow()).currentRevision, null);
  const r = await http('POST', `/api/scans/${id}/promote`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.roomCreated, true);
  roomId = r.json.roomId;
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { walls: { include: { openings: true } } } });
  assert.equal(room.draftWorkspaceId, null);
  assert.equal(room.slug, 'family-room');
  assert.equal(room.ceilingIn, 108);
  assert.equal(room.walls.length, 4);
  assert.equal(room.walls.flatMap((w) => w.openings).length, 3);
  assert.equal((await prisma.house.findFirstOrThrow()).currentRevision, 1);
  const rev = await prisma.revision.findFirstOrThrow({ where: { scope: 'current', number: 1 }, include: { changes: true } });
  assert.equal(rev.kind, 'rescan'); assert.equal(rev.actor, 'michael'); assert.equal(rev.workspaceId, null);
  assert.ok(rev.changes.some((c) => c.op === 'create' && c.entityType === 'room' && c.entityId === roomId));
  // 1 ceiling + 4 walls x 5 + 3 openings x 4
  assert.equal(await prisma.measurement.count({ where: { source: 'scan' } }), 33);
  assert.equal((await http('POST', `/api/scans/${id}/promote`)).status, 409);
  // The Test room workspace is untouched.
  assert.equal(await prisma.placement.count(), before.placements);
  assert.equal(await prisma.wall.count({ where: { roomId: draftRoom } }), before.draftWalls);
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: W } })).revision, before.ws.revision);
  const house = (await http('GET', '/api/house')).json;
  assert.equal(house.hasCurrent, true);
  assert.equal(house.current.rooms[0].walls.length, 4);
});

test('Current is locked: editor saves, proposals and system fields cannot touch it', async () => {
  const wall = await prisma.wall.findFirstOrThrow({ where: { roomId } });
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: W } });
  await assert.rejects(prisma.$transaction((t) => saveChanges(t, W, ws.revision, [{ op: 'update', entityType: 'wall', entityId: wall.id, field: 'heightIn', after: 90 }])), /belongs to Current/);
  await assert.rejects(prisma.$transaction((t) => saveChanges(t, W, ws.revision, [{ op: 'create', entityType: 'room', fields: { houseId: 1, slug: 'x', label: 'x', ceilingIn: 96 } }])), /can't be created/);
  await assert.rejects(prisma.$transaction((t) => saveChanges(t, W, ws.revision, [{ op: 'update', entityType: 'room', entityId: draftRoom, field: 'measurementStatus', after: 'scan' }])), /can't be changed/);
  await assert.rejects(prisma.$transaction((t) => applyOps(t, [{ op: 'update', entityType: 'wall', entityId: wall.id, field: 'heightIn', after: 90 }], { workspaceId: null, mode: 'save' })), /Current only changes/);
  await assert.rejects(prisma.$transaction((t) => applyOps(t, [{ op: 'update', entityType: 'wall', entityId: wall.id, field: 'heightIn', after: 90 }], { workspaceId: null, mode: 'rescan' })), /Current only changes/);
  await assert.rejects(createProposal({ title: 'Lower the Current wall', rationale: 'Testing that proposals cannot reach Current', workspaceId: W, roomIds: [draftRoom], source: { kind: 'bot' },
    changes: [{ op: 'update', entityType: 'wall', entityId: wall.id, field: 'heightIn', value: 90 }],
    cost: { steps: [{ step: 'other', changes: 'Nothing real', lowUsd: 0, highUsd: 0 }] } } as any, { actor: 'agent' }), /Current/);
  assert.equal((await prisma.wall.findUniqueOrThrow({ where: { id: wall.id } })).heightIn, 108);
  // Michael's normal editor save still returns a plain revision number.
  const s = await prisma.$transaction((t) => saveChanges(t, W, ws.revision, [{ op: 'update', entityType: 'room', entityId: draftRoom, field: 'label', after: 'Den 2' }]));
  assert.equal(typeof s.revision, 'number');
});

test('rescan: walls and openings matched (ids kept), pins win, scan values still recorded; rollback restores', async () => {
  const before = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { walls: { include: { openings: true }, orderBy: { id: 'asc' } } } });
  const [north, east, south, west] = before.walls; // as created from SAMPLE.walls order
  // Pin the north wall's height and the west wall's end point (via the measurements API path).
  await prisma.$transaction((t) => recordMeasurement(t, { workspaceId: null, entityType: 'wall', entityId: north.id, field: 'heightIn', valueIn: 100, source: 'manual', actor: 'michael' }));
  await prisma.$transaction((t) => recordMeasurement(t, { workspaceId: null, entityType: 'wall', entityId: west.id, field: 'endYIn', valueIn: 1, source: 'manual', actor: 'michael' }));
  assert.equal((await prisma.house.findFirstOrThrow()).currentRevision, 3); // two pin revisions
  // Second scan: different heading (quarter turn + 3 deg) and position; east wall measures 2"
  // longer, window moved 6", south and west walls not captured.
  const second = buildCapturedRoom({
    yawDeg: 123, origin: { x: -2, z: 5 }, floorY: -1.31,
    walls: [[0, 0, 144, 0], [144, 0, 144, 158]],
    windows: [{ wall: 0, offsetIn: 48, widthIn: 60, heightIn: 48, sillIn: 36 }],
    openings: [{ wall: 1, offsetIn: 42, widthIn: 72, heightIn: 84 }],
  });
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  const id = await scanVia(await pair({ roomId: room.id }), second);
  const r = await http('POST', `/api/scans/${id}/promote`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.roomCreated, false);
  assert.equal(r.json.revision, 4);
  const after = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { walls: { include: { openings: true }, orderBy: { id: 'asc' } } } });
  const ids = after.walls.map((w) => w.id);
  assert.ok(ids.includes(north.id) && ids.includes(east.id), 'matched walls keep their ids');
  assert.ok(!ids.includes(south.id), 'unpinned wall missing from the scan is removed');
  assert.ok(ids.includes(west.id), 'wall with a pinned value is kept even though the scan missed it');
  const n2 = after.walls.find((w) => w.id === north.id)!;
  assert.equal(n2.heightIn, 100, 'pinned height wins over the scan');
  const e2 = after.walls.find((w) => w.id === east.id)!;
  assert.equal(e2.endYIn, 158, 'unpinned endpoints follow the scan');
  assert.equal(n2.startXIn, north.startXIn);
  const win = n2.openings.find((o) => o.type === 'window')!;
  assert.equal(win.id, north.openings.find((o) => o.type === 'window')!.id, 'window matched, id kept');
  assert.equal(win.offsetIn, 48);
  assert.equal(after.walls.find((w) => w.id === west.id)!.endYIn, 1, 'pinned end point untouched');
  // The scan's height for the pinned wall is still on record.
  const rows = await prisma.measurement.findMany({ where: { entityType: 'wall', entityId: north.id, field: 'heightIn' }, orderBy: { id: 'asc' } });
  assert.deepEqual(rows.map((m) => [m.source, m.valueIn]), [['scan', 108], ['manual', 100], ['scan', 108]]);
  assert.match(r.json.kept.join(' '), /pinned/);

  // Roll Current back to before the rescan (revision 3).
  assert.equal((await http('POST', '/api/current/rollback', { toRevision: 3 }, 'agent')).status, 403);
  assert.equal((await http('POST', '/api/current/rollback', { toRevision: 3 }, 'none')).status, 401);
  const rb = await http('POST', '/api/current/rollback', { toRevision: 3 });
  assert.equal(rb.status, 200, JSON.stringify(rb.json));
  assert.equal(rb.json.revision, 5);
  const back = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { walls: { include: { openings: true }, orderBy: { id: 'asc' } } } });
  assert.deepEqual(back.walls.map((w) => w.id), before.walls.map((w) => w.id), 'deleted wall restored with its id');
  assert.equal(back.walls[1].endYIn, east.endYIn);
  assert.equal(back.walls[0].heightIn, 100, 'pins are kept through rollback');
  assert.equal(back.walls[0].openings.find((o) => o.type === 'window')!.offsetIn, 42);
  const hist = (await http('GET', '/api/current/history')).json;
  assert.deepEqual(hist.slice(0, 2).map((h: any) => h.kind), ['rollback', 'rescan']);
  assert.equal((await http('POST', '/api/current/rollback', { toRevision: 0 })).status, 400);
});
