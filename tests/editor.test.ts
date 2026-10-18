/**
 * Editor undo/redo, existing furniture and colors in Current, and scanned L-sectionals:
 *  - undo of a saved edit = a NEW revision that reverts it (ids kept, conflict and stale checks); redo
 *    = revert of the undo; measurements withdrawn/restored; the client's per-tab stack (undo.js)
 *  - Current holds placements and room colors, changed only through approved proposals (colors and
 *    templates via MCP, "Make this Current's furniture"), never by direct saves; rollback works
 *  - new designs start from Current's furniture and colors
 *  - RoomPlan's separate sofa boxes of an L-sectional (+ attached ottoman) merge into one l_sectional
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

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
const { syncTemplates, checkParam } = await import('../server/templates.js');
const { applyOps } = await import('../server/changes.js');
const { mergeSectionals, footprint } = await import('../server/sectional.js');
const { unmirrorObjects } = await import('../server/scans.js');
// @ts-ignore plain JS modules
const { UndoBook, applyEntry, shortcutFor } = await import('../undo.js');
// @ts-ignore plain JS module
const { buildCapturedRoom, SAMPLE } = await import('../fixtures/roomplan-builder.mjs');

const SESSION = 'michael-editor-session';
const READ_KEY = 'hp_read_editor_test';
const PROPOSE_KEY = 'hp_propose_editor_test';
let fam = 0, win = 0, northWall = 0;

type Who = 'michael' | 'read' | 'agent' | 'none';
async function http(method: string, path: string, body?: unknown, who: Who = 'michael') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'michael') headers.cookie = `hp_session=${SESSION}`;
  if (who === 'read') headers.authorization = `Bearer ${READ_KEY}`;
  if (who === 'agent') headers.authorization = `Bearer ${PROPOSE_KEY}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = (r: { status: number; json: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };
const mcp = async (name: string, args: any = {}) => {
  const res = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${PROPOSE_KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body: any = await res.json();
  const text = body.result.content[0].text;
  return { isError: !!body.result.isError, text, data: body.result.isError ? null : JSON.parse(text) };
};
const cost = { steps: [{ step: 'other', changes: 'n/a', lowUsd: 0, highUsd: 0 }] };
const rev = async (wsId: number) => (await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })).revision;
const curRev = async () => (await prisma.house.findFirstOrThrow()).currentRevision!;
const save = async (wsId: number, changes: any[], note?: string) => ok(await http('POST', `/api/workspaces/${wsId}/changes`, { baseRevision: await rev(wsId), changes, note }));
const revert = (wsId: number, baseRevision: number, revision: number, who: Who = 'michael') => http('POST', `/api/workspaces/${wsId}/revert`, { baseRevision, revision }, who);

before(async () => {
  await prepareTestDb();
  await seedHouse(prisma as any, {
    house: { name: 'Editor test house' },
    current: { rooms: [{
      id: 'fam', label: 'Family', ceiling: 9,
      walls: [{ id: 'n', a: [0, 0], b: [20, 0], height: 9 }, { id: 'e', a: [20, 0], b: [20, 14], height: 9 }, { id: 's', a: [20, 14], b: [0, 14], height: 9 }, { id: 'w', a: [0, 14], b: [0, 0], height: 9 }],
      openings: [{ id: 'win', type: 'window', wall: 'n', offset: 4, width: 5 }],
    }] },
    workspaces: [{ id: 'test', name: 'Test room', notes: 'fixture', rooms: [{ id: 'den', label: 'Den', ceiling: 8, walls: [{ id: 'w1', a: [0, 0], b: [10, 0], height: 8 }], openings: [], furniture: [] }] }],
  });
  await prisma.$transaction((tx) => syncTemplates(tx as any), { timeout: 60_000 });
  fam = (await prisma.room.findFirstOrThrow({ where: { draftWorkspaceId: null } })).id;
  northWall = (await prisma.wall.findFirstOrThrow({ where: { roomId: fam, label: 'n' } })).id;
  win = (await prisma.opening.findFirstOrThrow({ where: { wallId: northWall } })).id;
  const u = await prisma.user.create({ data: { name: 'Michael' } });
  await prisma.session.create({ data: { userId: u.id, tokenHash: sha256(SESSION), expiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.agentKey.create({ data: { name: 'editor read', scope: 'read', prefix: 'hp_read_', keyHash: sha256(READ_KEY) } });
  await prisma.agentKey.create({ data: { name: 'editor propose', scope: 'propose', prefix: 'hp_propose_', keyHash: sha256(PROPOSE_KEY) } });
});
after(async () => { await prisma.$disconnect(); s3srv.close(); });

let A = 0; // a design workspace on Current
test('undo/redo of saved edits: new revisions that revert (ids kept); conflict and stale checks; Michael only', async () => {
  const ws = ok(await http('POST', '/api/workspaces', { name: 'Undo design', furnishings: 'none' }), 201);
  A = ws.id;
  assert.equal(ws.revision, 0);
  assert.ok(ws.rooms.some((r: any) => r.id === fam));
  // Add a piece (furniture_item + placement).
  const add = await save(A, [
    { op: 'create', entityType: 'furniture_item', tempRef: 'i', fields: { kind: 'sofa', name: 'Sofa', wIn: 84, dIn: 36, hIn: 32, status: 'idea' } },
    { op: 'create', entityType: 'placement', tempRef: 'p', fields: { roomId: fam, itemId: '$i', xIn: 100, yIn: 60, rotationDeg: 0, action: 'new' } },
  ], 'Added Sofa');
  const pl = add.refs.p, item = add.refs.i;
  // Move + rotate in one save, then undo it.
  const mv = await save(A, [{ op: 'update', entityType: 'placement', entityId: pl, field: 'xIn', value: 120 }, { op: 'update', entityType: 'placement', entityId: pl, field: 'rotationDeg', value: 90 }], 'Moved Sofa');
  assert.equal((await revert(A, mv.revision, mv.revision, 'agent')).status, 403);
  assert.equal((await revert(A, mv.revision, mv.revision, 'none')).status, 401);
  const u1 = ok(await revert(A, mv.revision, mv.revision));
  assert.equal(u1.revision, mv.revision + 1);
  let p = await prisma.placement.findUniqueOrThrow({ where: { id: pl } });
  assert.deepEqual([p.xIn, p.rotationDeg], [100, 0]);
  // History is append-only: the undo is a normal revision pointing at the one it reverts.
  const hist = ok(await http('GET', `/api/workspaces/${A}/history`, undefined, 'read'));
  assert.equal(hist[0].number, u1.revision); assert.equal(hist[0].kind, 'save'); assert.match(hist[0].note, /Undid revision/);
  assert.ok(hist.some((h: any) => h.number === mv.revision));
  // Redo = undo of the undo.
  const r1 = ok(await revert(A, u1.revision, u1.revision));
  p = await prisma.placement.findUniqueOrThrow({ where: { id: pl } });
  assert.deepEqual([p.xIn, p.rotationDeg], [120, 90]);
  // A stale base revision is a conflict (another device saved).
  assert.equal((await revert(A, u1.revision, r1.revision)).json.error, 'conflict');
  // A later edit to the same value: undoing the older revision is refused and changes nothing.
  const later = await save(A, [{ op: 'update', entityType: 'placement', entityId: pl, field: 'xIn', value: 130 }]);
  const st = await revert(A, later.revision, r1.revision);
  assert.equal(st.status, 409); assert.equal(st.json.error, 'stale'); assert.match(st.json.message, /changed since that edit/);
  assert.equal((await prisma.placement.findUniqueOrThrow({ where: { id: pl } })).xIn, 130);
  assert.equal(await rev(A), later.revision);
  // Template + params, then delete; undoing the delete brings the same placement id and params back.
  const sofaTpl = (await prisma.furnitureTemplate.findUniqueOrThrow({ where: { slug: 'sofa' } })).id;
  await save(A, [{ op: 'update', entityType: 'placement', entityId: pl, field: 'templateId', value: sofaTpl }, { op: 'create', entityType: 'placement_param', fields: { placementId: pl, key: 'cushionCount', value: '2' } }]);
  const del = await save(A, [{ op: 'delete', entityType: 'placement', entityId: pl }], 'Removed Sofa');
  assert.equal(await prisma.placement.count({ where: { id: pl } }), 0);
  const u2 = ok(await revert(A, del.revision, del.revision));
  p = await prisma.placement.findUniqueOrThrow({ where: { id: pl }, include: { params: true } });
  assert.equal(p.templateId, sofaTpl); assert.deepEqual(p.params.map((x) => [x.key, x.value]), [['cushionCount', '2']]);
  // Redo the delete, then undo it again.
  const r2 = ok(await revert(A, u2.revision, u2.revision));
  assert.equal(await prisma.placement.count({ where: { id: pl } }), 0);
  ok(await revert(A, r2.revision, r2.revision));
  assert.equal(await prisma.placement.count({ where: { id: pl } }), 1);
  // Room colors: create, change, undo the change, undo the create.
  const c1 = await save(A, [{ op: 'create', entityType: 'room_style', tempRef: 's', fields: { roomId: fam, wallColor: '#eeeeee' } }]);
  const c2 = await save(A, [{ op: 'update', entityType: 'room_style', entityId: c1.refs.s, field: 'wallColor', value: '#112233' }]);
  ok(await revert(A, c2.revision, c2.revision));
  assert.equal((await prisma.roomStyle.findUniqueOrThrow({ where: { id: c1.refs.s } })).wallColor, '#eeeeee');
  ok(await revert(A, await rev(A), c1.revision));
  assert.equal(await prisma.roomStyle.count({ where: { workspaceId: A } }), 0);
  // Undo of an add removes the piece and its catalog item (nothing else uses it).
  const add2 = await save(A, [
    { op: 'create', entityType: 'furniture_item', tempRef: 'i', fields: { kind: 'box', name: 'Box', wIn: 10, dIn: 10, hIn: 10, status: 'idea' } },
    { op: 'create', entityType: 'placement', tempRef: 'p', fields: { roomId: fam, itemId: '$i', xIn: 20, yIn: 20, rotationDeg: 0, action: 'new' } },
  ]);
  ok(await revert(A, add2.revision, add2.revision));
  assert.equal(await prisma.placement.count({ where: { id: add2.refs.p } }), 0);
  assert.equal(await prisma.furnitureItem.count({ where: { id: add2.refs.i } }), 0);
  assert.equal(await prisma.furnitureItem.count({ where: { id: item } }), 1);
  assert.equal((await revert(A, await rev(A), 999)).status, 404);
  // Current wasn't touched by any of it.
  assert.equal(await prisma.placement.count({ where: { workspaceId: null } }), 0);
});

test('measurement undo: withdraw falls back to the previous value; restore brings it back; pins too', async () => {
  const wall = () => prisma.wall.findUniqueOrThrow({ where: { id: northWall } });
  const before = (await wall()).heightIn;
  const c0 = await curRev();
  const m = ok(await http('POST', '/api/measurements', { workspaceId: null, entityType: 'wall', entityId: northWall, field: 'heightIn', valueIn: 100, action: 'measured' }));
  assert.equal((await wall()).heightIn, 100);
  assert.equal((await http('POST', `/api/measurements/${m.measurementId}/withdraw`, { withdrawn: true, restoreIn: before }, 'agent')).status, 403);
  const w = ok(await http('POST', `/api/measurements/${m.measurementId}/withdraw`, { withdrawn: true, restoreIn: before }));
  assert.equal(w.withdrawn, true);
  assert.equal((await wall()).heightIn, before);
  assert.equal((await http('POST', `/api/measurements/${m.measurementId}/withdraw`, { withdrawn: true })).json.error, 'already_withdrawn');
  ok(await http('POST', `/api/measurements/${m.measurementId}/withdraw`, { withdrawn: false }));
  assert.equal((await wall()).heightIn, 100);
  // A pin: withdrawing it releases it; the measured 100 is used again.
  const pin = ok(await http('POST', '/api/measurements', { workspaceId: null, entityType: 'opening', entityId: win, field: 'widthIn', valueIn: 61, action: 'pin' }));
  assert.equal((await prisma.opening.findUniqueOrThrow({ where: { id: win } })).widthIn, 61);
  ok(await http('POST', `/api/measurements/${pin.measurementId}/withdraw`, { withdrawn: true, restoreIn: 60 }));
  assert.equal((await prisma.opening.findUniqueOrThrow({ where: { id: win } })).widthIn, 60);
  const hist = ok(await http('GET', `/api/measurements?entityType=opening&entityId=${win}`, undefined, 'read'));
  assert.ok(Array.isArray(hist) || typeof hist === 'object');
  // Every step was a Current revision (history kept).
  assert.ok((await curRev()) >= c0 + 5);
});

test('client undo stack: per tab, redo cleared by new edits, entries reverse themselves; shortcuts ignored while typing', async () => {
  const book = new UndoBook(3);
  const h = book.of('ws:1');
  for (const n of [1, 2, 3, 4]) h.record({ kind: 'rev', wsId: 1, revision: n, label: `edit ${n}` });
  assert.equal(h.undo.length, 3); // limit
  assert.equal(book.of('ws:2').canUndo, false); // per tab
  const calls: any[] = [];
  let next = 10;
  const deps = {
    revert: async (wsId: number, revision: number) => { calls.push(['revert', wsId, revision]); return { revision: next++, unchanged: false }; },
    dropDraft: (d: any) => { calls.push(['drop', d.id]); return d.id !== 'gone'; },
    queueDraft: (d: any) => calls.push(['queue', d.id]),
    withdraw: async (...a: any[]) => { calls.push(['withdraw', ...a]); },
    pin: async (_b: any, v: number) => { calls.push(['pin', v]); return { measurementId: 77 }; },
  };
  const back = await applyEntry(h.undo.pop(), deps);
  assert.deepEqual(back, { kind: 'rev', wsId: 1, revision: 10, label: 'edit 4' });
  const fwd = await applyEntry(back, deps); // redo reverts the undo revision
  assert.deepEqual(calls.slice(-1)[0], ['revert', 1, 10]);
  assert.equal(fwd.revision, 11);
  h.redo.push(back); h.record({ kind: 'rev', wsId: 1, revision: 12 }); assert.equal(h.canRedo, false);
  // Offline drafts: undo drops it from the queue, redo queues it again; a draft that was already sent gives nothing.
  const d = { id: 'd1' };
  const rq = await applyEntry({ kind: 'draft', wsId: 1, draft: d }, deps);
  assert.equal(rq.kind, 'requeue');
  assert.equal((await applyEntry(rq, deps)).kind, 'draft');
  assert.equal(await applyEntry({ kind: 'draft', wsId: 1, draft: { id: 'gone' } }, deps), null);
  // Saved later: the entry becomes a revision entry.
  h.record({ kind: 'draft', wsId: 1, draft: { id: 'd2' }, label: 'Moved' });
  book.replaceAll((e: any) => e.draft?.id === 'd2', (e: any) => ({ kind: 'rev', wsId: 1, revision: 20, label: e.label }));
  assert.deepEqual(h.peekUndo(), { kind: 'rev', wsId: 1, revision: 20, label: 'Moved' });
  // Measurements flip between withdrawn and restored; an unpin is undone by pinning again.
  const m1 = await applyEntry({ kind: 'meas', measurementId: 5, withdraw: true, restoreIn: 96, workspaceId: null }, deps);
  assert.equal(m1.withdraw, false);
  const rp = await applyEntry({ kind: 'repin', key: 'cur', body: { workspaceId: null }, valueIn: 60 }, deps);
  assert.deepEqual([rp.kind, rp.measurementId, rp.withdraw], ['meas', 77, true]);
  // Shortcuts.
  const ev = (o: any) => ({ key: 'z', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(shortcutFor(ev({ metaKey: true }), null), 'undo');
  assert.equal(shortcutFor(ev({ metaKey: true, shiftKey: true, key: 'Z' }), null), 'redo');
  assert.equal(shortcutFor(ev({ ctrlKey: true }), null), 'undo');
  assert.equal(shortcutFor(ev({ ctrlKey: true, key: 'y' }), null), 'redo');
  assert.equal(shortcutFor(ev({ ctrlKey: true, shiftKey: true }), null), 'redo');
  assert.equal(shortcutFor(ev({}), null), null);
  assert.equal(shortcutFor(ev({ metaKey: true }), { tagName: 'INPUT', type: 'number' }), null);
  assert.equal(shortcutFor(ev({ metaKey: true }), { tagName: 'TEXTAREA' }), null);
  assert.equal(shortcutFor(ev({ metaKey: true }), { tagName: 'DIV', isContentEditable: true }), null);
  assert.equal(shortcutFor(ev({ metaKey: true }), { tagName: 'BUTTON' }), 'undo');
});

let F = 0, curSofa = 0;
test('Current holds furniture and colors: only via approved proposals; direct saves refused', async () => {
  // Direct (editor) edits to Current are refused, even for furniture.
  const item = await prisma.furnitureItem.create({ data: { kind: 'sofa', name: 'X', wIn: 80, dIn: 36, hIn: 30, status: 'existing' } });
  await assert.rejects(prisma.$transaction((t) => applyOps(t, [{ op: 'create', entityType: 'placement', fields: { roomId: fam, itemId: item.id, xIn: 1, yIn: 1, rotationDeg: 0, action: 'existing' } }], { workspaceId: null, mode: 'save' })), /Current/);
  // Colors read from photos, for Current (MCP, propose key).
  const c0 = await curRev();
  const pc = await mcp('propose_colors', { current: true, roomId: fam, wall: { name: 'Swiss Coffee', color: '#F1EDE3' }, trim: { color: '#FFFFFF' }, rationale: 'Colors in the photos', source: { kind: 'bot' }, cost });
  assert.equal(pc.isError, false, pc.text);
  assert.equal(pc.data.target.kind, 'current'); assert.equal(pc.data.target.what, 'furnishings'); assert.equal(pc.data.status, 'pending');
  assert.equal(await prisma.roomStyle.count({ where: { workspaceId: null } }), 0);
  assert.equal((await mcp('propose_colors', { current: true, workspaceId: A, roomId: fam, wall: { color: '#000000' }, rationale: 'x', source: { kind: 'bot' }, cost })).isError, true);
  // Structure in a Current proposal is refused.
  const bad = await http('POST', '/api/proposals', { title: 'Wall', rationale: 'x', current: true, roomIds: [fam], source: { kind: 'bot' }, changes: [{ op: 'update', entityType: 'wall', entityId: northWall, field: 'heightIn', value: 90 }], cost }, 'agent');
  assert.equal(bad.status, 403, JSON.stringify(bad.json));
  assert.equal((await http('POST', `/api/proposals/${pc.data.id}/approve`, {}, 'agent')).status, 403);
  const preview = ok(await http('GET', `/api/proposals/${pc.data.id}/preview`, undefined, 'read'));
  assert.equal(preview.rooms.find((r: any) => r.id === fam).style.wallColor, '#f1ede3');
  const ap = ok(await http('POST', `/api/proposals/${pc.data.id}/approve`, {}));
  assert.equal(ap.workspaceId, null);
  assert.equal(await curRev(), c0 + 1);
  const house = ok(await http('GET', '/api/house', undefined, 'read'));
  const room = house.current.rooms.find((r: any) => r.id === fam);
  assert.equal(room.wallColor.name, 'Swiss Coffee'); assert.equal(room.wallColor.color, '#f1ede3');
  ok(await http('GET', `/api/rooms/${fam}`, undefined, 'read')); // a Current room without a workspace = Current's view
  // "Make this Current's furniture": a workspace with two existing pieces (one with a template) and one new idea.
  const ws = ok(await http('POST', '/api/workspaces', { name: 'Furnish from scan', furnishings: 'none' }), 201);
  F = ws.id;
  const lt = (await prisma.furnitureTemplate.findUniqueOrThrow({ where: { slug: 'l_sectional' } })).id;
  const s = await save(F, [
    { op: 'create', entityType: 'furniture_item', tempRef: 'i1', fields: { kind: 'sofa', name: 'Sectional', wIn: 120, dIn: 90, hIn: 34, status: 'existing' } },
    { op: 'create', entityType: 'placement', tempRef: 'p1', fields: { roomId: fam, itemId: '$i1', xIn: 90, yIn: 110, rotationDeg: 0, action: 'existing', templateId: lt } },
    { op: 'create', entityType: 'placement_param', fields: { placementId: '$p1', key: 'chaiseSide', value: 'right' } },
    { op: 'create', entityType: 'placement_param', fields: { placementId: '$p1', key: 'ottomanSide', value: 'left' } },
    { op: 'create', entityType: 'furniture_item', tempRef: 'i2', fields: { kind: 'tv', name: 'TV', wIn: 61, dIn: 4, hIn: 33, status: 'existing' } },
    { op: 'create', entityType: 'placement', fields: { roomId: fam, itemId: '$i2', xIn: 6, yIn: 84, rotationDeg: 270, action: 'existing' } },
    { op: 'create', entityType: 'furniture_item', tempRef: 'i3', fields: { kind: 'box', name: 'New lamp idea', wIn: 12, dIn: 12, hIn: 60, status: 'idea' } },
    { op: 'create', entityType: 'placement', fields: { roomId: fam, itemId: '$i3', xIn: 30, yIn: 30, rotationDeg: 0, action: 'new' } },
    { op: 'create', entityType: 'room_style', fields: { roomId: fam, wallColor: '#ddeeff', floorColor: '#7a5a3a' } },
  ]);
  const fRev = s.revision;
  assert.equal((await http('POST', `/api/workspaces/${F}/propose-as-current`, undefined, 'agent')).status, 403);
  const mk = ok(await http('POST', `/api/workspaces/${F}/propose-as-current`), 201);
  assert.equal(mk.status, 'pending'); assert.equal(mk.target.kind, 'current'); assert.match(mk.rationale, /New lamp idea/);
  assert.equal(await prisma.placement.count({ where: { workspaceId: null } }), 0); // nothing until approved
  assert.equal(await rev(F), fRev); // the workspace isn't touched
  const list = ok(await http('GET', '/api/proposals?status=pending&current=1', undefined, 'read'));
  assert.ok(list.some((p: any) => p.id === mk.id));
  const c1 = await curRev();
  ok(await http('POST', `/api/proposals/${mk.id}/approve`, {}));
  assert.equal(await curRev(), c1 + 1);
  const cur = await prisma.placement.findMany({ where: { workspaceId: null }, include: { params: true, item: true }, orderBy: { id: 'asc' } });
  assert.deepEqual(cur.map((p) => p.item.name), ['Sectional', 'TV']);
  assert.equal(cur[0].templateId, lt);
  assert.deepEqual(cur[0].params.map((p) => [p.key, p.value]).sort(), [['chaiseSide', 'right'], ['ottomanSide', 'left']]);
  curSofa = cur[0].id;
  const st = await prisma.roomStyle.findFirstOrThrow({ where: { workspaceId: null, roomId: fam } });
  assert.equal(st.wallColor, '#ddeeff'); assert.equal(st.floorColor, '#7a5a3a'); assert.equal(st.wallColorName, null);
  assert.equal(await prisma.roomStyle.count({ where: { workspaceId: null } }), 1);
  assert.equal(await prisma.placement.count({ where: { workspaceId: F } }), 3); // still all there
  // Template proposal on a Current placement: the target defaults to Current.
  const pt = await mcp('propose_furniture_template', { placementId: curSofa, template: 'l_sectional', params: { chaiseDepthIn: 90, chaiseWidthIn: 40, ottomanWidthIn: 34, ottomanDepthIn: 28 }, rationale: 'Measured from the scan', source: { kind: 'bot' }, cost });
  assert.equal(pt.isError, false, pt.text);
  assert.equal(pt.data.target.kind, 'current');
  assert.equal((await mcp('propose_furniture_template', { workspaceId: F, placementId: curSofa, template: 'l_sectional', params: {}, rationale: 'x', source: { kind: 'bot' }, cost })).isError, true);
  ok(await http('POST', `/api/proposals/${pt.data.id}/approve`, {}));
  const params = await prisma.placementParam.findMany({ where: { placementId: curSofa } });
  assert.equal(params.find((p) => p.key === 'chaiseWidthIn')!.value, '40');
  assert.equal(params.find((p) => p.key === 'ottomanDepthIn')!.value, '28');
  // Current's view and history show it.
  const h = ok(await http('GET', '/api/current/history', undefined, 'read'));
  assert.equal(h[0].kind, 'proposal');
});

test('new designs start from Current (furniture, params, colors); blank ones do not; edits stay in the design', async () => {
  const d = ok(await http('POST', '/api/workspaces', { name: 'Ideas' }), 201);
  assert.equal(d.revision, 1);
  const room = d.rooms.find((r: any) => r.id === fam);
  assert.deepEqual(room.furniture.map((f: any) => f.item.name).sort(), ['Sectional', 'TV']);
  const sect = room.furniture.find((f: any) => f.item.name === 'Sectional');
  assert.equal(sect.template.slug, 'l_sectional'); assert.equal(sect.template.params.chaiseWidthIn, '40');
  assert.notEqual(sect.id, curSofa);
  assert.equal(room.style.wallColor, '#ddeeff');
  // Undo can't go past where the design started.
  assert.equal((await revert(d.id, 1, 1)).json.error, 'before_start');
  await save(d.id, [{ op: 'update', entityType: 'placement', entityId: sect.id, field: 'xIn', value: 10 }, { op: 'update', entityType: 'room_style', entityId: room.style.id, field: 'wallColor', value: '#000000' }]);
  assert.equal((await prisma.placement.findUniqueOrThrow({ where: { id: curSofa } })).xIn, 90);
  assert.equal((await prisma.roomStyle.findFirstOrThrow({ where: { workspaceId: null } })).wallColor, '#ddeeff');
  const blank = ok(await http('POST', '/api/workspaces', { name: 'Blank', furnishings: 'none' }), 201);
  assert.equal(blank.rooms.find((r: any) => r.id === fam).furniture.length, 0);
});

test('Current rollback removes approved furniture again; a proposal against a changed Current is refused', async () => {
  // Stale: propose colors for Current, then change Current (another approval), then approve the first.
  const p1 = await mcp('propose_colors', { current: true, roomId: fam, wall: { color: '#123456' }, rationale: 'a', source: { kind: 'bot' }, cost });
  const p2 = await mcp('propose_colors', { current: true, roomId: fam, wall: { color: '#654321' }, rationale: 'b', source: { kind: 'bot' }, cost });
  ok(await http('POST', `/api/proposals/${p2.data.id}/approve`, {}));
  const r = await http('POST', `/api/proposals/${p1.data.id}/approve`, {});
  assert.equal(r.status, 409, JSON.stringify(r.json));
  // Roll Current back to before "Make Current's furniture".
  const h = ok(await http('GET', '/api/current/history', undefined, 'read'));
  const mkRev = h.find((x: any) => x.kind === 'proposal' && /Current's furniture/.test(x.proposal?.title ?? ''));
  assert.ok(mkRev, JSON.stringify(h.map((x: any) => [x.number, x.kind, x.proposal?.title])));
  ok(await http('POST', '/api/current/rollback', { toRevision: mkRev.number - 1 }));
  assert.equal(await prisma.placement.count({ where: { workspaceId: null } }), 0);
  const st = await prisma.roomStyle.findFirstOrThrow({ where: { workspaceId: null } });
  assert.equal(st.wallColor, '#f1ede3'); // back to the first approved colors
  assert.equal(await prisma.placement.count({ where: { workspaceId: F } }), 3);
});

// ---------------------------------------------------------------------------
// Scanned L-sectionals
// ---------------------------------------------------------------------------
const box = (key: string, x: number, y: number, rot: number, w: number, d: number, h = 34) => ({ key, kind: 'sofa', xIn: x, yIn: y, rotationDeg: rot, widthIn: w, depthIn: d, heightIn: h });
/** Plan rectangle (AABB) of a part of the l_sectional drawn by scene.js, local x range and z range in inches. */
function partInPlan(m: any, x0: number, x1: number, z0: number, z1: number) {
  const t = (m.rotationDeg * Math.PI) / 180, r = { x: Math.cos(t), y: Math.sin(t) }, f = { x: Math.sin(t), y: -Math.cos(t) };
  const pts = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([x, z]) => ({ x: m.xIn + x * r.x + z * f.x, y: m.yIn + x * r.y + z * f.y }));
  return { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
}
/** The part of the chaise that sticks out in front of the run (the scanned chaise box). */
function chaiseOf(m: any, runDepth: number) {
  const w = m.widthIn, d = m.depthIn, s = m.params.chaiseSide === 'left' ? -1 : 1, cw = Number(m.params.chaiseWidthIn), cl = Number(m.params.chaiseDepthIn);
  return partInPlan(m, s > 0 ? w / 2 - cw : -w / 2, s > 0 ? w / 2 : -w / 2 + cw, -d / 2 + runDepth, -d / 2 + cl);
}
function ottomanOf(m: any, runDepth: number) {
  const w = m.widthIn, d = m.depthIn, s = m.params.ottomanSide === 'left' ? -1 : 1, ow = Number(m.params.ottomanWidthIn), od = Number(m.params.ottomanDepthIn);
  return partInPlan(m, s > 0 ? w / 2 - ow : -w / 2, s > 0 ? w / 2 : -w / 2 + ow, -d / 2 + runDepth, -d / 2 + runDepth + od);
}
const near = (a: any, b: any, tol: number, msg: string) => { for (const k of ['x0', 'x1', 'y0', 'y1']) assert.ok(Math.abs(a[k] - b[k]) <= tol, `${msg} ${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };

test('sectional merge: synthetic L in all four orientations; straight sofas and loose pieces stay separate', () => {
  // Run along x (12..108, y 101..139) with the chaise sticking out toward -y at the right end.
  const base = [box('run', 60, 120, 0, 96, 38), box('chaise', 90, 77, 90, 50, 36)];
  const turn = (o: any, q: number) => { // rotate the layout about the origin by q quarter turns (plan, counterclockwise)
    let { xIn: x, yIn: y } = o;
    for (let i = 0; i < q; i++) [x, y] = [-y, x];
    return { ...o, xIn: x, yIn: y, rotationDeg: (o.rotationDeg + 90 * q) % 360 };
  };
  for (const q of [0, 1, 2, 3]) {
    const objs = base.map((o) => turn(o, q));
    const { merged, rest } = mergeSectionals([...objs, turn(box('far', 400, 400, 0, 84, 36), q)]);
    assert.equal(merged.length, 1, `q=${q}`);
    assert.deepEqual(rest.map((o) => o.key), ['far']);
    const m = merged[0];
    assert.equal(m.widthIn, 96); assert.equal(m.depthIn, 87);
    assert.equal(m.rotationDeg, (90 * q) % 360);
    assert.equal(m.params.chaiseSide, 'right'); assert.equal(m.params.chaiseDepthIn, '87'); assert.equal(m.params.chaiseWidthIn, '36');
    assert.equal(m.params.ottomanSide, 'none');
    assert.equal(m.params.seatDepthIn, '27');
    near(chaiseOf(m, 38), footprint(objs[1]), 1.5, `chaise q=${q}`);
    for (const [k, v] of Object.entries(m.params)) checkParam('l_sectional', k, v); // all in range
  }
  // A lone sofa, two sofas side by side in a line, and pieces sticking out on both sides of the run (not an L) stay separate.
  assert.equal(mergeSectionals([box('a', 50, 50, 0, 84, 36)]).merged.length, 0);
  assert.equal(mergeSectionals([box('a', 50, 50, 0, 84, 36), box('b', 136, 50, 0, 84, 36)]).merged.length, 0);
  assert.equal(mergeSectionals([box('a', 60, 120, 0, 96, 38), box('c', 90, 77, 90, 50, 36), box('b', 30, 160, 90, 40, 36)]).merged.length, 0);
  // A long return (81" out) is still an L with a long chaise.
  assert.equal(mergeSectionals([box('a', 60, 120, 0, 96, 38), box('c', 90, 60, 90, 80, 36)]).merged[0].params.chaiseDepthIn, '119');
  // Boxes 7" apart don't count as attached.
  assert.equal(mergeSectionals([box('run', 60, 120, 0, 96, 38), box('chaise', 90, 71, 90, 50, 36)]).merged.length, 0);
});

test('sectional merge: Michael\'s scan #1 geometry (private fixture, not in the repo) gives one L with chaise and ottoman', (t) => {
  const path = 'fixtures/private/scan1-sofas.json';
  if (!existsSync(path)) { t.skip('fixtures/private/scan1-sofas.json is not present (real house data is never committed)'); return; }
  const fx = JSON.parse(readFileSync(path, 'utf8'));
  const ex = fx.expected; // expected values live with the private data, not in this public repo
  // Furnish runs on the corrected (unmirrored) frame; check both.
  for (const objs of [fx.objects, unmirrorObjects({ walls: [{ startYIn: 0, endYIn: fx.maxY }], objects: fx.objects })]) {
    const { merged, rest } = mergeSectionals(objs);
    assert.equal(merged.length, 1, JSON.stringify(merged));
    const m = merged[0];
    assert.equal(m.keys.length, 3);
    assert.deepEqual(rest.map((o: any) => [o.widthIn, o.depthIn]), ex.separate); // a separate sofa a few inches away
    assert.equal(m.name, 'L-sectional with ottoman (scanned, 3 pieces)');
    assert.deepEqual([m.widthIn, m.depthIn], [ex.widthIn, ex.depthIn]);
    assert.notEqual(m.params.ottomanSide, m.params.chaiseSide);
    for (const k of ['chaiseDepthIn', 'chaiseWidthIn', 'seatDepthIn', 'cushionCount', 'ottomanWidthIn', 'ottomanDepthIn']) assert.equal(m.params[k], ex[k], k);
    const parts = m.keys.map((k: string) => objs.find((o: any) => o.key === k)).map((o: any) => ({ o, b: footprint(o) }));
    const chaise = parts.find((p: any) => p.o.widthIn === ex.chaiseWidth)!, ott = parts.find((p: any) => p.o.widthIn === ex.ottomanWidth)!;
    near(chaiseOf(m, ex.runDepth), chaise.b, 3, 'chaise');
    near(ottomanOf(m, ex.runDepth), ott.b, 3, 'ottoman');
  }
});

test('furnish from scan merges the L-sectional boxes into one l_sectional placement', async () => {
  const pairTok = ok(await http('POST', '/api/upload-tokens', { newRoom: true, label: 'Sectional room' }), 201).token;
  const room = buildCapturedRoom({ ...SAMPLE, objects: [
    { cat: 'sofa', x: 60, z: 120, w: 96, h: 34, d: 38 }, // run
    { cat: 'sofa', x: 90, z: 77, w: 36, h: 34, d: 50 }, // chaise (axis-aligned box, 36 wide in x)
    { cat: 'sofa', x: 23, z: 88, w: 22, h: 30, d: 26 }, // attached ottoman at the other end
    { cat: 'table', x: 120, z: 30, w: 30, h: 18, d: 20 },
  ] });
  const p = ok(await http('POST', '/api/uploads/presigned', { token: pairTok, kind: 'scan', format: 'roomplan_json' }, 'none'));
  const bytes = new TextEncoder().encode(JSON.stringify(room));
  assert.equal((await fetch(p.url, { method: 'PUT', body: bytes, headers: { 'content-type': p.contentType } })).status, 200);
  ok(await http('POST', `/api/uploads/${p.uploadId}/complete`, { token: pairTok, bytes: bytes.byteLength }, 'none'));
  const si = ok(await http('POST', '/api/scans/import', { token: pairTok, uploadId: p.uploadId, roomplanData: room }, 'none'), 201);
  ok(await http('POST', `/api/scans/${si.id}/promote`));
  const r = ok(await http('POST', `/api/scans/${si.id}/furnish`, { name: 'Sectional furniture' }), 201);
  assert.equal(r.mergedSectionals, 1);
  assert.equal(r.placements, 2, JSON.stringify(r));
  const ws = ok(await http('GET', `/api/workspaces/${r.workspaceId}`, undefined, 'read'));
  const roomId = (await prisma.scanImport.findUniqueOrThrow({ where: { id: si.id } })).roomId;
  const pcs = ws.rooms.find((x: any) => x.id === roomId).furniture;
  const sect = pcs.find((f: any) => f.template?.slug === 'l_sectional');
  assert.ok(sect, JSON.stringify(pcs.map((f: any) => [f.item.name, f.template?.slug])));
  assert.equal(sect.item.name, 'L-sectional with ottoman (scanned, 3 pieces)');
  assert.equal(sect.template.params.ottomanSide === 'none', false);
  assert.equal(sect.template.params.chaiseWidthIn, '36');
  assert.ok(pcs.some((f: any) => f.template?.slug === 'coffee_table' || f.template?.slug === 'side_table'));
});
