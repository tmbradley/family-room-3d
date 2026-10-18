/**
 * P1 tests: proposal apply / reject / stale / rollback, pin protection, new-workspace proposals,
 * auth scopes, and the MCP endpoint. Needs a throwaway MySQL database:
 *   TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/hp_test npm test
 * tests/setup.ts and tests/helpers.ts refuse anything but an empty or suite-marked test database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
const { prisma, prepareTestDb } = await import('./helpers.js');
const { seedHouse } = await import('../server/seed.js');
const { createProposal, approveProposal, rejectProposal, previewProposal } = await import('../server/proposals.js');
const { saveChanges, rollbackWorkspace, getHistory } = await import('../server/changes.js');
const { recordMeasurement, unpin } = await import('../server/measurements.js');
const { app } = await import('../server/app.js');
const { sha256 } = await import('../server/util.js');

// Small synthetic house (not Michael's real data): one test workspace, one room, two pieces.
const fixture = {
  house: { name: 'Test house' },
  current: null,
  workspaces: [{
    id: 'test', name: 'Test room', notes: 'fixture',
    rooms: [{
      id: 'den', label: 'Den', ceiling: 8,
      walls: [{ id: 'w1', a: [0, 0], b: [10, 0], height: 8 }, { id: 'w2', a: [0, 0], b: [0, 10], height: 8 }],
      openings: [{ id: 'win', wall: 'w1', type: 'window', offset: 3, width: 4, sill: 3, head: 7 }],
      furniture: [
        { id: 'sofa', kind: 'sofa', name: 'Sofa', w: 84, d: 36, h: 32, x: 5, z: 3, rot: 0 },
        { id: 'chair', kind: 'chair', name: 'Chair', w: 30, d: 30, h: 30, x: 2, z: 7, rot: 90 },
      ],
    }],
  }],
};

let W = 0, roomId = 0, sofa = 0, chair = 0, wallId = 0, windowId = 0;
const PROPOSE_KEY = 'hp_propose_test_key_123';
const READ_KEY = 'hp_read_test_key_456';

const ws = () => prisma.workspace.findUniqueOrThrow({ where: { id: W } });
const placement = (id: number) => prisma.placement.findUnique({ where: { id } });
const tx = <T>(fn: (t: any) => Promise<T>) => prisma.$transaction(fn, { timeout: 30_000 });
const cost = { steps: [{ step: 'furniture' as const, changes: 'Move a chair', lowUsd: 0, highUsd: 0 }] };
const propose = (changes: any[], extra: any = {}) =>
  createProposal({ title: 'Test proposal', rationale: 'because', workspaceId: W, roomIds: [roomId], source: { kind: 'bot' }, changes, cost, ...extra }, { actor: 'agent' });

before(async () => {
  await prepareTestDb();
  await seedHouse(prisma as any, fixture);
  W = (await prisma.workspace.findFirstOrThrow()).id;
  roomId = (await prisma.room.findFirstOrThrow()).id;
  const pls = await prisma.placement.findMany({ include: { item: true }, orderBy: { id: 'asc' } });
  sofa = pls.find((p) => p.item.name === 'Sofa')!.id;
  chair = pls.find((p) => p.item.name === 'Chair')!.id;
  wallId = (await prisma.wall.findFirstOrThrow({ where: { label: 'w1' } })).id;
  windowId = (await prisma.opening.findFirstOrThrow()).id;
  await prisma.agentKey.create({ data: { name: 'test propose', scope: 'propose', prefix: 'hp_propose_', keyHash: sha256(PROPOSE_KEY) } });
  await prisma.agentKey.create({ data: { name: 'test read', scope: 'read', prefix: 'hp_read_', keyHash: sha256(READ_KEY) } });
});
after(async () => { await prisma.$disconnect(); });

test('seed: no Current, test workspace at revision 1', async () => {
  const h = await prisma.house.findFirstOrThrow();
  assert.equal(h.currentRevision, null);
  assert.equal((await ws()).revision, 1);
});

test('approve applies field changes and a new piece as one new revision', async () => {
  const p = await propose([
    { op: 'update', entityType: 'placement', entityId: chair, field: 'xIn', value: 40 },
    { op: 'create', entityType: 'furniture_item', tempRef: 'i1', fields: { kind: 'box', name: 'Walnut credenza', wIn: 60, dIn: 18, hIn: 26, status: 'idea' } },
    { op: 'create', entityType: 'placement', tempRef: 'p1', fields: { roomId, itemId: '$i1', xIn: 60, yIn: 110, rotationDeg: 180, action: 'new' } },
  ]);
  assert.equal(p.status, 'pending');
  assert.equal(p.changes[0].before, '24');
  // Nothing changed yet; preview shows the change without saving it.
  assert.equal((await placement(chair))!.xIn, 24);
  const prev = await previewProposal(p.id);
  assert.equal(prev.rooms[0].furniture.find((f: any) => f.id === chair)!.xIn, 40);
  assert.equal(prev.rooms[0].furniture.length, 3);
  assert.equal((await placement(chair))!.xIn, 24);
  assert.equal(await prisma.furnitureItem.count({ where: { name: 'Walnut credenza' } }), 0);

  const r = await approveProposal(p.id, 'looks good');
  assert.equal(r.revision, 2);
  assert.equal((await placement(chair))!.xIn, 40);
  assert.equal(await prisma.placement.count({ where: { workspaceId: W } }), 3);
  const saved = await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } });
  assert.equal(saved.status, 'approved');
  const [h] = await getHistory(prisma as any, W, 1);
  assert.equal(h.kind, 'proposal');
  assert.equal(h.proposal!.id, p.id);
  await assert.rejects(approveProposal(p.id), /already approved/);
});

test('reject changes nothing and keeps the proposal', async () => {
  const before = (await ws()).revision;
  const p = await propose([{ op: 'update', entityType: 'placement', entityId: sofa, field: 'rotationDeg', value: 180 }]);
  const r = await rejectProposal(p.id, 'no');
  assert.equal(r.status, 'rejected');
  assert.equal((await placement(sofa))!.rotationDeg, 0);
  assert.equal((await ws()).revision, before);
  const kept = await prisma.proposal.findUniqueOrThrow({ where: { id: p.id }, include: { changes: true } });
  assert.equal(kept.status, 'rejected');
  assert.equal(kept.decisionNote, 'no');
  assert.ok(kept.changes.length > 0);
  await assert.rejects(approveProposal(p.id), /already rejected/);
});

test('editor save is a revision; conflicting base revision is refused; stale proposal is refused', async () => {
  const rev = (await ws()).revision;
  const p = await propose([{ op: 'update', entityType: 'placement', entityId: sofa, field: 'yIn', value: 50 }]);
  const s = await tx((t) => saveChanges(t, W, rev, [{ op: 'update', entityType: 'placement', entityId: sofa, field: 'yIn', after: 44 }]));
  assert.equal(s.revision, rev + 1);
  await assert.rejects(tx((t) => saveChanges(t, W, rev, [{ op: 'update', entityType: 'placement', entityId: sofa, field: 'yIn', after: 45 }])), /revision/);
  await assert.rejects(approveProposal(p.id), /changed since this was proposed/);
  assert.equal((await placement(sofa))!.yIn, 44);
});

test('rollback restores earlier state (updates, creates, deletes) as a new revision, and can be undone', async () => {
  const start = (await ws()).revision;
  const chairX = (await placement(chair))!.xIn;
  await tx((t) => saveChanges(t, W, start, [{ op: 'update', entityType: 'placement', entityId: chair, field: 'xIn', after: 70 }]));
  await tx((t) => saveChanges(t, W, start + 1, [{ op: 'delete', entityType: 'placement', entityId: sofa }]));
  assert.equal(await placement(sofa), null);
  const r = await tx((t) => rollbackWorkspace(t, W, start));
  assert.equal(r.revision, start + 3);
  assert.equal((await placement(chair))!.xIn, chairX);
  const restored = await placement(sofa);
  assert.ok(restored, 'deleted placement restored');
  assert.equal(restored!.yIn, 44);
  assert.equal(restored!.workspaceId, W);
  const [h] = await getHistory(prisma as any, W, 1);
  assert.equal(h.kind, 'rollback');
  // Undo the rollback: back to the state with the sofa deleted.
  await tx((t) => rollbackWorkspace(t, W, start + 2));
  assert.equal(await placement(sofa), null);
  assert.equal((await placement(chair))!.xIn, 70);
  // And back again so later tests have the sofa.
  await tx((t) => rollbackWorkspace(t, W, start));
  assert.ok(await placement(sofa));
  // Rolling back to the start of the whole history (past the seed) is refused.
  await assert.rejects(tx((t) => rollbackWorkspace(t, W, 0)), /where this workspace started/);
  // The approved proposal's new piece goes away when rolling back to revision 1.
  await tx((t) => rollbackWorkspace(t, W, 1));
  assert.equal(await prisma.placement.count({ where: { workspaceId: W } }), 2);
  assert.equal((await placement(chair))!.xIn, 24);
});

test('pinned measurements are never overwritten by scans, estimates, proposals, saves or rollbacks', async () => {
  const pre = (await ws()).revision;
  const pin = await tx((t) => recordMeasurement(t, { workspaceId: W, entityType: 'wall', entityId: wallId, field: 'heightIn', valueIn: 97, source: 'manual', actor: 'michael' }));
  assert.equal(pin.applied, true);
  assert.equal(pin.pinned, true);
  assert.equal((await prisma.wall.findUniqueOrThrow({ where: { id: wallId } })).heightIn, 97);

  const scan = await tx((t) => recordMeasurement(t, { workspaceId: W, entityType: 'wall', entityId: wallId, field: 'heightIn', valueIn: 95, source: 'scan', actor: 'system' }));
  assert.equal(scan.applied, false);
  assert.equal(scan.pinned, true);
  const est = await tx((t) => recordMeasurement(t, { workspaceId: W, entityType: 'wall', entityId: wallId, field: 'heightIn', valueIn: 90, source: 'manual_estimate', actor: 'agent' }));
  assert.equal(est.applied, false);
  const meas = await tx((t) => recordMeasurement(t, { workspaceId: W, entityType: 'wall', entityId: wallId, field: 'heightIn', valueIn: 98, source: 'measured', actor: 'michael' }));
  assert.equal(meas.applied, false);
  assert.equal((await prisma.wall.findUniqueOrThrow({ where: { id: wallId } })).heightIn, 97);
  assert.equal(await prisma.measurement.count({ where: { entityType: 'wall', entityId: wallId, field: 'heightIn' } }), 5, 'all values kept for history');

  await assert.rejects(propose([{ op: 'update', entityType: 'wall', entityId: wallId, field: 'heightIn', value: 90 }]), /pinned/);
  const r = (await ws()).revision;
  await assert.rejects(tx((t) => saveChanges(t, W, r, [{ op: 'update', entityType: 'wall', entityId: wallId, field: 'heightIn', after: 90 }])), /pinned/);
  const rb = await tx((t) => rollbackWorkspace(t, W, pre));
  assert.equal((await prisma.wall.findUniqueOrThrow({ where: { id: wallId } })).heightIn, 97);
  assert.ok(rb.skipped.some((s) => s.includes('heightIn')));

  // Pinning a window width through the same path, then unpinning falls back to the newest real measurement.
  const u = await tx((t) => unpin(t, { workspaceId: W, entityType: 'wall', entityId: wallId, field: 'heightIn' }));
  assert.equal(u.effective!.valueIn, 98);
  assert.equal((await prisma.wall.findUniqueOrThrow({ where: { id: wallId } })).heightIn, 98);
  const p2 = await tx((t) => recordMeasurement(t, { workspaceId: W, entityType: 'opening', entityId: windowId, field: 'widthIn', valueIn: 50, source: 'manual', actor: 'michael' }));
  assert.equal(p2.pinned, true);
  await assert.rejects(tx((t) => recordMeasurement(t, { workspaceId: W, entityType: 'placement', entityId: chair, field: 'xIn', valueIn: 1, source: 'manual', actor: 'michael' })), /isn't a measurement/);
});

test('new-workspace proposal copies the base on approval and leaves the base alone', async () => {
  const baseRev = (await ws()).revision;
  const p = await createProposal({
    title: 'Moody den', rationale: 'darker', newWorkspace: { name: 'Moody den', copyFromWorkspaceId: W }, roomIds: [roomId],
    source: { kind: 'x_bookmark', url: 'https://x.com/example/status/1' },
    changes: [{ op: 'update', entityType: 'placement', entityId: chair, field: 'xIn', value: 33 }, { op: 'update', entityType: 'room', entityId: roomId, field: 'wallColor', value: '#2f3b33' }],
    cost: { steps: [{ step: 'paint', changes: 'Paint walls dark green', lowUsd: 150, highUsd: 400 }, { step: 'furniture', changes: 'Move chair', lowUsd: 0, highUsd: 0 }] },
  }, { actor: 'agent' });
  assert.equal(p.target.kind, 'new_workspace');
  assert.equal(p.cost.lowUsd, 150);
  assert.equal(p.cost.steps.length, 2);
  const r = await approveProposal(p.id);
  assert.notEqual(r.workspaceId, W);
  const copy = await prisma.workspace.findUniqueOrThrow({ where: { id: r.workspaceId } });
  assert.equal(copy.name, 'Moody den');
  assert.equal(copy.sourceProposalId, p.id);
  const copyRoom = await prisma.room.findFirstOrThrow({ where: { draftWorkspaceId: copy.id } });
  assert.equal(copyRoom.wallColor, '#2f3b33');
  const copyChair = await prisma.placement.findFirstOrThrow({ where: { workspaceId: copy.id, item: { name: 'Chair' } } });
  assert.equal(copyChair.xIn, 33);
  // Base unchanged.
  assert.equal((await ws()).revision, baseRev);
  assert.equal((await placement(chair))!.xIn, 24);
  assert.notEqual((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).wallColor, '#2f3b33');
  // Pins were copied along with the measurements.
  const pinned = await prisma.measurement.count({ where: { entityType: 'opening', source: 'manual', isOverride: true, unpinnedAt: null } });
  assert.equal(pinned, 2);
});

test('proposals can only touch their own workspace', async () => {
  const other = await prisma.workspace.findFirstOrThrow({ where: { NOT: { id: W } } });
  const otherPl = await prisma.placement.findFirstOrThrow({ where: { workspaceId: other.id } });
  await assert.rejects(propose([{ op: 'update', entityType: 'placement', entityId: otherPl.id, field: 'xIn', value: 1 }]), /isn't part of workspace/);
  await assert.rejects(propose([{ op: 'update', entityType: 'placement', entityId: chair, field: 'workspaceId', value: other.id }]), /can't be changed/);
});

const call = (path: string, init: RequestInit & { key?: string } = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.headers as any) } });

test('HTTP auth: 401 signed out, agents read and propose but never approve, save, roll back or pin', async () => {
  assert.equal((await call('/api/house')).status, 401);
  assert.equal((await call('/api/workspaces', { key: 'nope' })).status, 401);
  assert.equal((await call('/api/workspaces', { key: READ_KEY })).status, 200);
  const body = JSON.stringify({ title: 'Read key try', rationale: 'x', workspaceId: W, roomIds: [roomId], source: { kind: 'bot' }, changes: [{ op: 'update', entityType: 'placement', entityId: chair, field: 'xIn', value: 30 }], cost });
  assert.equal((await call('/api/proposals', { method: 'POST', key: READ_KEY, body })).status, 403);
  const created = await call('/api/proposals', { method: 'POST', key: PROPOSE_KEY, body });
  assert.equal(created.status, 201);
  const p = await created.json() as any;
  assert.equal(p.createdBy, 'agent');
  for (const [path, b] of [
    [`/api/proposals/${p.id}/approve`, {}],
    [`/api/proposals/${p.id}/reject`, {}],
    [`/api/workspaces/${W}/changes`, { baseRevision: 1, changes: [{ op: 'update', entityType: 'placement', entityId: chair, field: 'xIn', value: 1 }] }],
    [`/api/workspaces/${W}/rollback`, { toRevision: 1 }],
    ['/api/measurements', { workspaceId: W, entityType: 'wall', entityId: wallId, field: 'heightIn', valueIn: 1, action: 'pin' }],
    ['/api/workspaces', { name: 'x' }],
  ] as const) {
    const res = await call(path, { method: 'POST', key: PROPOSE_KEY, body: JSON.stringify(b) });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } })).status, 'pending');
});

const mcp = async (key: string | undefined, method: string, params: any = {}) => {
  const res = await call('/mcp', {
    method: 'POST', key, headers: { accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
};

test('MCP: auth, tool list by scope, create_proposal leaves it pending', async () => {
  assert.equal((await mcp(undefined, 'tools/list')).status, 401);
  const init = await mcp(PROPOSE_KEY, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.serverInfo.name, 'house-planner');
  const tools = (await mcp(PROPOSE_KEY, 'tools/list')).body.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(tools, ['create_proposal', 'get_history', 'get_room', 'get_scan_import', 'get_workspace', 'list_models', 'list_proposals', 'list_room_photos', 'list_templates', 'list_workspaces', 'propose_attach_model', 'propose_colors', 'propose_furniture_template']);
  const readTools = (await mcp(READ_KEY, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(!readTools.includes('create_proposal'));
  const res = await mcp(PROPOSE_KEY, 'tools/call', {
    name: 'create_proposal',
    arguments: {
      title: 'MCP sample', rationale: 'test', workspaceId: W, roomIds: [roomId], source: { kind: 'bot' },
      changes: [{ op: 'update', entityType: 'placement', entityId: chair, field: 'rotationDeg', value: 180 }], cost,
    },
  });
  const out = JSON.parse(res.body.result.content[0].text);
  assert.equal(out.status, 'pending');
  assert.equal((await placement(chair))!.rotationDeg, 90);
  const bad = await mcp(PROPOSE_KEY, 'tools/call', { name: 'create_proposal', arguments: { title: 'pin', rationale: 'x', workspaceId: W, roomIds: [roomId], source: { kind: 'bot' }, changes: [{ op: 'update', entityType: 'opening', entityId: windowId, field: 'widthIn', value: 10 }], cost } });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /pinned/);
  const ws = JSON.parse((await mcp(READ_KEY, 'tools/call', { name: 'get_workspace', arguments: { workspaceId: W } })).body.result.content[0].text);
  assert.equal(ws.id, W);
  const hist = JSON.parse((await mcp(READ_KEY, 'tools/call', { name: 'get_history', arguments: { workspaceId: W } })).body.result.content[0].text);
  assert.ok(hist.length > 3);
});
