/**
 * Navigation redesign (server side):
 *  - design names are unique per room among live designs (create, copy, rename, restore refuse;
 *    agents' new-design proposals and automatic names get " 2", " 3"); name-check suggests one
 *  - archive / restore: hidden, read-only, nothing deleted; refused while proposals are pending
 *  - the list says where a design came from, its rooms and when it was last edited
 *  - Save to Current in one step (summary = approval), rolled back from History
 *  - "Approved · Undo": rolls the target back and puts the proposal back to pending
 *  - migration 0007 backfills which scan a furnished design came from
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { prisma, prepareTestDb } = await import('./helpers.js');
const { seedHouse } = await import('../server/seed.js');
const { app } = await import('../server/app.js');
const { sha256 } = await import('../server/util.js');

const SESSION = 'michael-designs-session';
const PROPOSE_KEY = 'hp_propose_designs_test';
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
const ok = (r: { status: number; json: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };
const cost = { steps: [{ step: 'other', changes: 'n/a', lowUsd: 0, highUsd: 0 }] };
const rev = async (wsId: number) => (await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })).revision;
const curRev = async () => (await prisma.house.findFirstOrThrow()).currentRevision!;
const save = (wsId: number, changes: any[]) => rev(wsId).then((b) => http('POST', `/api/workspaces/${wsId}/changes`, { baseRevision: b, changes }));
const list = async () => ok(await http('GET', '/api/workspaces')) as any[];

let fam = 0, testWs = 0;
before(async () => {
  await prepareTestDb();
  await seedHouse(prisma as any, {
    house: { name: 'Designs test house' },
    current: { rooms: [{ id: 'fam', label: 'Family room', ceiling: 9, walls: [{ id: 'n', a: [0, 0], b: [20, 0], height: 9 }, { id: 'e', a: [20, 0], b: [20, 14], height: 9 }], openings: [] }] },
    workspaces: [{ id: 'test', name: 'Plan A', notes: 'draft room', rooms: [{ id: 'den', label: 'Den', ceiling: 8, walls: [{ id: 'w1', a: [0, 0], b: [10, 0], height: 8 }], openings: [], furniture: [] }] }],
  });
  fam = (await prisma.room.findFirstOrThrow({ where: { draftWorkspaceId: null } })).id;
  testWs = (await prisma.workspace.findFirstOrThrow({ where: { name: 'Plan A' } })).id;
  const u = await prisma.user.create({ data: { name: 'Michael' } });
  await prisma.session.create({ data: { userId: u.id, tokenHash: sha256(SESSION), expiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.agentKey.create({ data: { name: 'designs propose', scope: 'propose', prefix: 'hp_propose_', keyHash: sha256(PROPOSE_KEY) } });
});
after(async () => { await prisma.$disconnect(); });

let A = 0, B = 0;
test('design names are unique per room: create, copy, rename and restore refuse; agents and automatic names get a suffix', async () => {
  // "Plan A" already exists for the Den (a draft room): a Family room design may use it too.
  A = ok(await http('POST', '/api/workspaces', { name: 'Plan A' }), 201).id;
  const dup = await http('POST', '/api/workspaces', { name: '  plan   a ' });
  assert.equal(dup.status, 409); assert.equal(dup.json.error, 'name_taken');
  assert.match(dup.json.message, /That name is taken by another Family room design/);
  assert.equal(dup.json.details.suggestion, 'plan a 2');
  // Names are cleaned (spaces collapsed).
  B = ok(await http('POST', '/api/workspaces', { name: '  Plan   B ', furnishings: 'none' }), 201).id;
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: B } })).name, 'Plan B');
  // Copy of A under A's own name is refused (same room); under a new name it's fine.
  assert.equal((await http('POST', '/api/workspaces', { name: 'PLAN A', copyFromWorkspaceId: A })).json.error, 'name_taken');
  const C = ok(await http('POST', '/api/workspaces', { name: 'Copy of Plan A', copyFromWorkspaceId: A }), 201).id;
  // Rename (a revisioned workspace.name change) is refused when taken; renaming to itself in new case is fine.
  const r1 = await save(B, [{ op: 'update', entityType: 'workspace', entityId: B, field: 'name', value: 'plan a' }]);
  assert.equal(r1.status, 409); assert.equal(r1.json.error, 'name_taken');
  ok(await save(A, [{ op: 'update', entityType: 'workspace', entityId: A, field: 'name', value: 'PLAN A' }]));
  ok(await save(A, [{ op: 'update', entityType: 'workspace', entityId: A, field: 'name', value: 'Plan A' }]));
  assert.equal((await save(A, [{ op: 'update', entityType: 'workspace', entityId: A, field: 'name', value: '   ' }])).json.error, 'invalid_name');
  // name-check suggests the next free name.
  const nc = ok(await http('GET', `/api/workspaces/name-check?name=${encodeURIComponent('Plan A')}`));
  assert.equal(nc.free, false); assert.equal(nc.takenBy, A); assert.equal(nc.suggestion, 'Plan A 2');
  assert.equal(ok(await http('GET', `/api/workspaces/name-check?name=Fresh`)).free, true);
  assert.equal(ok(await http('GET', `/api/workspaces/name-check?name=${encodeURIComponent('Plan A')}&except=${A}`)).free, true);
  // An agent's new-design proposal with a taken name gets " 2" on approval.
  const p = ok(await http('POST', '/api/proposals', { title: 'Copy', rationale: 'x', newWorkspace: { name: 'Plan A', copyFromWorkspaceId: A }, roomIds: [fam], source: { kind: 'bot' }, changes: [{ op: 'create', entityType: 'furniture_item', fields: { kind: 'lamp', name: 'Idea lamp', wIn: 12, dIn: 12, hIn: 50, status: 'idea' } }], cost }, 'agent'), 201);
  const ap = ok(await http('POST', `/api/proposals/${p.id}/approve`, {}));
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: ap.workspaceId } })).name, 'Plan A 2');
  // Clean up for the next tests: archive the extra designs.
  for (const w of [C, ap.workspaceId]) ok(await http('POST', `/api/workspaces/${w}/archive`, { archived: true }));
});

test('archive and restore: Michael only, hidden and read-only, refused with pending proposals, nothing deleted', async () => {
  assert.equal((await http('POST', `/api/workspaces/${B}/archive`, { archived: true }, 'agent')).status, 403);
  // A pending proposal blocks archiving.
  const p = ok(await http('POST', '/api/proposals', { title: 'Rename', rationale: 'x', workspaceId: B, roomIds: [fam], source: { kind: 'bot' }, changes: [{ op: 'update', entityType: 'workspace', entityId: B, field: 'notes', value: 'hi' }], cost }, 'agent'), 201);
  assert.equal((await http('POST', `/api/workspaces/${B}/archive`, { archived: true })).json.error, 'has_pending');
  ok(await http('POST', `/api/proposals/${p.id}/reject`, { note: 'no' }));
  const before = await prisma.placement.count({ where: { workspaceId: B } });
  const a = ok(await http('POST', `/api/workspaces/${B}/archive`, { archived: true }));
  assert.ok(a.archivedAt);
  assert.equal(await prisma.placement.count({ where: { workspaceId: B } }), before);
  const row = (await list()).find((w) => w.id === B);
  assert.equal(row.archived, true);
  const view = ok(await http('GET', `/api/workspaces/${B}`));
  assert.equal(view.editable, false); assert.equal(view.archived, true);
  // Read-only: saves and proposals refused.
  assert.equal((await save(B, [{ op: 'update', entityType: 'workspace', entityId: B, field: 'notes', value: 'x' }])).json.error, 'archived');
  assert.equal((await http('POST', '/api/proposals', { title: 'Notes for B', rationale: 'x', workspaceId: B, roomIds: [fam], source: { kind: 'bot' }, changes: [{ op: 'update', entityType: 'workspace', entityId: B, field: 'notes', value: 'x' }], cost }, 'agent')).json.error, 'archived');
  // Its name is free while archived; restoring needs the name back.
  const B2 = ok(await http('POST', '/api/workspaces', { name: 'Plan B', furnishings: 'none' }), 201).id;
  const res = await http('POST', `/api/workspaces/${B}/archive`, { archived: false });
  assert.equal(res.json.error, 'name_taken'); assert.equal(res.json.details.suggestion, 'Plan B 2');
  ok(await http('POST', `/api/workspaces/${B2}/archive`, { archived: true }));
  assert.equal(ok(await http('POST', `/api/workspaces/${B}/archive`, { archived: false })).archivedAt, null);
  // Copying an archived design is fine (it reads it).
  ok(await http('POST', `/api/workspaces/${B2}/archive`, { archived: false }).then(() => http('GET', `/api/workspaces/${B2}`)));
});

test('the list carries rooms, origin, last edit and archive state', async () => {
  const rows = await list();
  const a = rows.find((w) => w.id === A);
  assert.deepEqual(a.roomIds, [fam]); assert.deepEqual(a.roomKeys, [`r:${fam}`]); assert.deepEqual(a.roomLabels, ['Family room']);
  assert.equal(a.origin.kind, 'current'); assert.equal(typeof a.origin.revision, 'number');
  assert.ok(new Date(a.updatedAt).getTime() >= new Date(a.createdAt).getTime());
  assert.equal(a.archived, false); assert.equal(a.sourceScanId, null);
  const copy = rows.find((w) => w.name === 'Copy of Plan A');
  assert.equal(copy.origin.kind, 'copy'); assert.equal(copy.origin.name, 'Plan A'); assert.equal(copy.origin.workspaceId, A);
  assert.equal(copy.archived, true);
  const den = rows.find((w) => w.id === testWs);
  assert.deepEqual(den.roomKeys, ['l:den']);
});

test('Save to Current: the summary is the approval; one step files and approves; rolled back from History', async () => {
  // A has an existing sofa, a keep chair and a new lamp; colors.
  const r = ok(await save(A, [
    { op: 'create', entityType: 'furniture_item', tempRef: 's', fields: { kind: 'sofa', name: 'Old sofa', wIn: 84, dIn: 36, hIn: 30, status: 'existing' } },
    { op: 'create', entityType: 'placement', fields: { roomId: fam, itemId: '$s', xIn: 40, yIn: 40, rotationDeg: 0, action: 'existing' } },
    { op: 'create', entityType: 'furniture_item', tempRef: 'l', fields: { kind: 'lamp', name: 'New lamp', wIn: 12, dIn: 12, hIn: 60, status: 'idea', priceCents: 12900 } },
    { op: 'create', entityType: 'placement', fields: { roomId: fam, itemId: '$l', xIn: 10, yIn: 10, rotationDeg: 0, action: 'new' } },
    { op: 'create', entityType: 'room_style', fields: { roomId: fam, wallColor: '#EEE8DD', wallColorName: 'Linen' } },
  ]));
  const sum = ok(await http('GET', `/api/workspaces/${A}/save-to-current`));
  assert.equal(sum.revision, r.revision);
  assert.deepEqual(sum.goesIn.map((x: any) => x.name), ['Old sofa']);
  assert.deepEqual(sum.leftOut.map((x: any) => x.name), ['New lamp']);
  assert.equal(sum.colors.length, 1); assert.equal(sum.colors[0].label, 'Family room');
  assert.equal(sum.nothingToChange, false);
  // Agents can't; a stale summary is refused.
  assert.equal((await http('POST', `/api/workspaces/${A}/save-to-current`, { revision: r.revision }, 'agent')).status, 403);
  assert.equal((await http('POST', `/api/workspaces/${A}/save-to-current`, { revision: r.revision - 1 })).json.error, 'stale');
  const c0 = await curRev();
  const done = ok(await http('POST', `/api/workspaces/${A}/save-to-current`, { revision: r.revision }), 201);
  assert.equal(done.currentRevision, c0 + 1);
  const prop = await prisma.proposal.findUniqueOrThrow({ where: { id: done.proposalId } });
  assert.equal(prop.status, 'approved'); assert.equal(prop.targetCurrent, true);
  const cur = await prisma.placement.findMany({ where: { workspaceId: null, roomId: fam }, include: { item: true } });
  assert.deepEqual(cur.map((p) => p.item.name), ['Old sofa']);
  assert.equal((await prisma.roomStyle.findFirstOrThrow({ where: { workspaceId: null, roomId: fam } })).wallColorName, 'Linen');
  // The design itself is not changed.
  assert.equal(await rev(A), r.revision);
  // Nothing more to save now.
  assert.equal(ok(await http('GET', `/api/workspaces/${A}/save-to-current`)).nothingToChange, true);
  assert.equal((await http('POST', `/api/workspaces/${A}/save-to-current`, { revision: r.revision })).json.error, 'nothing_to_change');
  assert.equal(await prisma.proposal.count({ where: { status: 'pending' } }), 0);
  // Roll back from History.
  ok(await http('POST', '/api/current/rollback', { toRevision: c0 }));
  assert.equal(await prisma.placement.count({ where: { workspaceId: null, roomId: fam } }), 0);
});

test('Approved · Undo: rolls the target back and puts the proposal back to pending; a new design is archived', async () => {
  const p = ok(await http('POST', '/api/proposals', { title: 'Notes', rationale: 'x', workspaceId: A, roomIds: [fam], source: { kind: 'bot' }, changes: [{ op: 'update', entityType: 'workspace', entityId: A, field: 'notes', value: 'from agent' }], cost }, 'agent'), 201);
  const r0 = await rev(A);
  ok(await http('POST', `/api/proposals/${p.id}/approve`, {}));
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: A } })).notes, 'from agent');
  assert.equal((await http('POST', `/api/proposals/${p.id}/undo-approve`, {}, 'agent')).status, 403);
  const u = ok(await http('POST', `/api/proposals/${p.id}/undo-approve`, {}));
  assert.equal(u.status, 'pending'); assert.equal(u.rolledBackTo, r0);
  const w = await prisma.workspace.findUniqueOrThrow({ where: { id: A } });
  assert.notEqual(w.notes, 'from agent'); assert.equal(w.revision, r0 + 2); // approval + rollback, history kept
  assert.equal((await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } })).status, 'pending');
  // It can be approved again; after another edit, Undo is refused (History instead).
  ok(await http('POST', `/api/proposals/${p.id}/approve`, {}));
  ok(await save(A, [{ op: 'update', entityType: 'workspace', entityId: A, field: 'notes', value: 'mine' }]));
  assert.equal((await http('POST', `/api/proposals/${p.id}/undo-approve`, {})).json.error, 'stale');
  // A proposal that made a new design: Undo archives that design.
  const n = ok(await http('POST', '/api/proposals', { title: 'New', rationale: 'x', newWorkspace: { name: 'Agent idea', copyFromWorkspaceId: A }, roomIds: [fam], source: { kind: 'bot' }, changes: [{ op: 'create', entityType: 'furniture_item', fields: { kind: 'lamp', name: 'Idea lamp', wIn: 12, dIn: 12, hIn: 50, status: 'idea' } }], cost }, 'agent'), 201);
  const nap = ok(await http('POST', `/api/proposals/${n.id}/approve`, {}));
  const nu = ok(await http('POST', `/api/proposals/${n.id}/undo-approve`, {}));
  assert.equal(nu.archivedWorkspaceId, nap.workspaceId);
  const made = await prisma.workspace.findUniqueOrThrow({ where: { id: nap.workspaceId } });
  assert.ok(made.archivedAt); assert.equal(made.sourceProposalId, null);
  // Approving again makes a fresh design (the archived one keeps its name out of the way).
  const again = ok(await http('POST', `/api/proposals/${n.id}/approve`, {}));
  assert.notEqual(again.workspaceId, nap.workspaceId);
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: again.workspaceId } })).name, 'Agent idea');
});

test('migration 0007 backfills the scan a furnished design came from', async () => {
  const house = await prisma.house.findFirstOrThrow();
  const up = await prisma.upload.create({ data: { houseId: house.id, kind: 'scan', format: 'roomplan_json', bucketKey: 'test/backfill.json', uploadedBy: 'michael', status: 'imported' } });
  const scan = await prisma.scanImport.create({ data: { houseId: house.id, uploadId: up.id, status: 'promoted', label: 'Family room' } });
  const ws = await prisma.workspace.create({ data: { houseId: house.id, name: 'Old furnish', revision: 1, createdBy: 'michael' } });
  await prisma.revision.create({ data: { houseId: house.id, workspaceId: ws.id, scope: `workspace:${ws.id}`, number: 1, actor: 'michael', kind: 'save', note: `Furniture from scan #${scan.id}: 3 piece(s) matched to templates` } });
  const other = await prisma.workspace.create({ data: { houseId: house.id, name: 'Unrelated', revision: 1, createdBy: 'michael' } });
  await prisma.revision.create({ data: { houseId: house.id, workspaceId: other.id, scope: `workspace:${other.id}`, number: 1, actor: 'michael', kind: 'save', note: 'Furniture from scan #99999: gone' } });
  const sql = readFileSync('prisma/migrations/0007_design_archive_source_scan/migration.sql', 'utf8');
  const update = sql.slice(sql.indexOf('UPDATE `workspaces`'));
  await prisma.$executeRawUnsafe(update);
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).sourceScanId, scan.id);
  assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: other.id } })).sourceScanId, null); // scan doesn't exist
  // Furnishing that scan again opens this design.
  const row = (await list()).find((w) => w.id === ws.id);
  assert.equal(row.origin.kind, 'scan'); assert.equal(row.origin.scanId, scan.id);
});
