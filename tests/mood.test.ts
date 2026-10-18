/**
 * What makes a design's mood, on the plan:
 *  - lighting, wall decor, soft goods and plants, and the missing furniture are parametric templates in
 *    the template tables, grouped for the Add furniture menu, with a mount type and a typical price
 *  - design workspaces copied from Current can hold fixtures for their rooms (the "isn't a room of
 *    workspace" bug); Current still can't be given fixtures by a proposal
 *  - propose_pieces hangs wall pieces on a wall, sizes the TV from its screen, and planCost counts
 *    the pieces (own price, else the template's typical range) and wall finishes
 *  - per-wall color and finish (wall_style): designs, copies, Save to Current, rollback
 *  - migration 0009 gives existing designs a copy of Current's fixtures
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { prisma, prepareTestDb } = await import('./helpers.js');
const { seedHouse } = await import('../server/seed.js');
const { app } = await import('../server/app.js');
const { sha256 } = await import('../server/util.js');
const { syncTemplates, TEMPLATES, GROUPS, checkParam } = await import('../server/templates.js');
const { poseOnWall } = await import('../server/mounting.js');

const SESSION = 'michael-mood-session';
const PROPOSE_KEY = 'hp_propose_mood_test';
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
const mcp = async (name: string, args: any = {}) => {
  const res = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${PROPOSE_KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body: any = await res.json();
  const text = body.result.content[0].text;
  return { isError: !!body.result.isError, text, data: body.result.isError ? null : JSON.parse(text) };
};
const cost = { steps: [{ step: 'lighting', changes: 'n/a', lowUsd: 0, highUsd: 0 }] };
const src = { kind: 'bot' as const };
const rev = async (wsId: number) => (await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })).revision;
const save = (wsId: number, changes: any[]) => rev(wsId).then((b) => http('POST', `/api/workspaces/${wsId}/changes`, { baseRevision: b, changes }));

let fam = 0, wallN = 0, wallE = 0, fanFixture = 0, oldDesign = 0;
before(async () => {
  await prepareTestDb();
  await seedHouse(prisma as any, {
    house: { name: 'Mood test house' },
    current: { rooms: [{ id: 'fam', label: 'Family room', ceiling: 9,
      walls: [{ id: 'n', a: [0, 0], b: [20, 0], height: 9 }, { id: 'e', a: [20, 0], b: [20, 14], height: 9 }, { id: 's', a: [20, 14], b: [0, 14], height: 9 }, { id: 'w', a: [0, 14], b: [0, 0], height: 9 }],
      openings: [], fixtures: [{ type: 'ceilingFan', name: 'Black ceiling fan', x: 10, z: 7 }] }] },
    workspaces: [],
  });
  await prisma.$transaction((tx) => syncTemplates(tx as any), { timeout: 60_000 });
  fam = (await prisma.room.findFirstOrThrow({ where: { draftWorkspaceId: null } })).id;
  const walls = await prisma.wall.findMany({ where: { roomId: fam }, orderBy: { id: 'asc' } });
  wallN = walls[0].id; wallE = walls[1].id;
  fanFixture = (await prisma.fixture.findFirstOrThrow()).id;
  const u = await prisma.user.create({ data: { name: 'Michael' } });
  await prisma.session.create({ data: { userId: u.id, tokenHash: sha256(SESSION), expiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.agentKey.create({ data: { name: 'mood propose', scope: 'propose', prefix: 'hp_propose_', keyHash: sha256(PROPOSE_KEY) } });
  // A design from before migration 0009 (no copy of Current's fixtures).
  const house = await prisma.house.findFirstOrThrow();
  const ws = await prisma.workspace.create({ data: { houseId: house.id, name: 'Older design', revision: 1, createdBy: 'michael', baseRevision: house.currentRevision } });
  await prisma.workspaceRoom.create({ data: { workspaceId: ws.id, roomId: fam } });
  await prisma.revision.create({ data: { houseId: house.id, workspaceId: ws.id, scope: `workspace:${ws.id}`, number: 1, actor: 'michael', kind: 'copy', note: 'Started from Current (revision 1)' } });
  oldDesign = ws.id;
});
after(async () => { await prisma.$disconnect(); });

const NEW = ['pendant', 'swag_pendants', 'wall_sconce', 'swing_arm_lamp', 'table_lamp', 'led_strip', 'ceiling_fan',
  'framed_art', 'gallery_wall', 'wall_disk', 'mirror', 'wall_paneling', 'lit_niche', 'curtains', 'plant', 'pillows', 'throw_blanket',
  'console_table', 'dining_chair', 'cafe_table', 'wood_frame_lounge_chair', 'display_cabinet', 'tv', 'electric_fireplace', 'pouf', 'drum_side_table'];

test('templates: the mood pieces are in the template tables, grouped, with mount and typical price', async () => {
  assert.equal(TEMPLATES.length, 40);
  const groups = await prisma.templateGroup.findMany({ orderBy: { sort: 'asc' } });
  assert.deepEqual(groups.map((g) => g.key), GROUPS.map((g) => g.key));
  const list = ok(await http('GET', '/api/templates'));
  for (const s of NEW) assert.ok(list.some((t: any) => t.slug === s), s);
  // Ordered by menu section, then by the order in the library.
  const order = list.map((t: any) => GROUPS.findIndex((g) => g.key === t.group));
  assert.deepEqual(order, [...order].sort((a: number, b: number) => a - b));
  const pendant = list.find((t: any) => t.slug === 'pendant');
  assert.equal(pendant.group, 'lighting'); assert.equal(pendant.groupLabel, 'Lighting'); assert.equal(pendant.mount, 'ceiling');
  assert.deepEqual(pendant.typicalPriceUsd, { low: 40, high: 250 });
  assert.deepEqual(pendant.params.find((p: any) => p.key === 'shape').options.map((o: any) => o.value), ['globe', 'drum', 'cone', 'ufo_paper']);
  assert.deepEqual(pendant.params.find((p: any) => p.key === 'material').options.map((o: any) => o.value), ['rattan', 'paper', 'brass', 'glass']);
  assert.equal(list.find((t: any) => t.slug === 'framed_art').mount, 'wall');
  assert.equal(list.find((t: any) => t.slug === 'pillows').mount, 'soft');
  assert.equal(list.find((t: any) => t.slug === 'table_lamp').mount, 'surface');
  assert.equal(list.find((t: any) => t.slug === 'cafe_table').defaults.hIn, 29);
  // The floor lamp keeps its old parameters (placements that use them still draw) and gains shade styles.
  const fl = list.find((t: any) => t.slug === 'floor_lamp');
  for (const k of ['metalFinish', 'shadeColor', 'arc', 'shadeStyle', 'lit']) assert.ok(fl.params.some((p: any) => p.key === k), k);
  assert.equal(checkParam('curtains', 'opacity', 'sheer'), 'sheer');
  assert.throws(() => checkParam('plant', 'type', 'cactus'), /fiddle_leaf/);
  // Syncing again changes nothing.
  await prisma.$transaction((tx) => syncTemplates(tx as any), { timeout: 60_000 });
  assert.equal(await prisma.furnitureTemplate.count(), 40);
});

test('wall pose: centered on the wall face, facing into the room', () => {
  const walls = [{ id: 1, startXIn: 0, startYIn: 0, endXIn: 240, endYIn: 0 }, { id: 2, startXIn: 240, startYIn: 0, endXIn: 240, endYIn: 168 }, { id: 3, startXIn: 240, startYIn: 168, endXIn: 0, endYIn: 168 }, { id: 4, startXIn: 0, startYIn: 168, endXIn: 0, endYIn: 0 }];
  assert.deepEqual(poseOnWall(walls, 1, 60, 2), { xIn: 60, yIn: 1, rotationDeg: 180 });
  assert.deepEqual(poseOnWall(walls, 2, 84, 4), { xIn: 238, yIn: 84, rotationDeg: 270 });
  assert.deepEqual(poseOnWall(walls, 3, 40, 2), { xIn: 200, yIn: 167, rotationDeg: 0 });
  assert.deepEqual(poseOnWall(walls, 4, 84, 2), { xIn: 1, yIn: 84, rotationDeg: 90 });
  assert.throws(() => poseOnWall(walls, 1, 500, 2), /offsetIn/);
});

let D = 0;
test('designs copied from Current hold their own fixtures; Current does not take them from a proposal', async () => {
  D = ok(await http('POST', '/api/workspaces', { name: 'Moody den' }), 201).id;
  const view = ok(await http('GET', `/api/workspaces/${D}`));
  const fx = view.rooms[0].fixtures;
  assert.equal(fx.length, 1); assert.equal(fx[0].workspaceId, D); assert.notEqual(fx[0].id, fanFixture); // its own copy of the fan
  // The bug: a fixture in Current room `fam` inside a design proposal was refused ("isn't a room of workspace").
  const pr = await mcp('create_proposal', { title: 'Pendants as fixtures', rationale: 'x', workspaceId: D, roomIds: [fam], source: src, cost,
    changes: [{ op: 'create', entityType: 'fixture', tempRef: 'p1', fields: { roomId: fam, type: 'light', name: 'Rattan pendant', xIn: 200, yIn: 30 } },
      { op: 'update', entityType: 'fixture', entityId: fx[0].id, field: 'name', value: 'Fan (to replace)' }] });
  assert.equal(pr.isError, false, pr.text);
  // ... and in a new design copied from it (ids refer to the source design).
  const nw = await mcp('create_proposal', { title: 'New design with sheers', rationale: 'x', newWorkspace: { name: 'Moody den v2', copyFromWorkspaceId: D }, roomIds: [fam], source: src, cost,
    changes: [{ op: 'create', entityType: 'fixture', fields: { roomId: fam, wallId: wallN, type: 'window_treatment', name: 'Linen sheers' } }, { op: 'delete', entityType: 'fixture', entityId: fx[0].id }] });
  assert.equal(nw.isError, false, nw.text);
  ok(await http('POST', `/api/proposals/${pr.data.id}/approve`, {}));
  const after = ok(await http('GET', `/api/workspaces/${D}`)).rooms[0].fixtures;
  assert.deepEqual(after.map((f: any) => f.name).sort(), ['Fan (to replace)', 'Rattan pendant']);
  const approved = ok(await http('POST', `/api/proposals/${nw.data.id}/approve`, {}));
  const v2 = ok(await http('GET', `/api/workspaces/${approved.workspaceId}`)).rooms[0].fixtures;
  assert.deepEqual(v2.map((f: any) => f.name).sort(), ['Linen sheers', 'Rattan pendant']);
  // Current is unchanged: still just its fan.
  const cur = ok(await http('GET', '/api/house')).current.rooms[0].fixtures;
  assert.deepEqual(cur.map((f: any) => f.id), [fanFixture]);
  const bad = await mcp('create_proposal', { title: 'Fixture in Current', rationale: 'x', current: true, roomIds: [fam], source: src, cost, changes: [{ op: 'create', entityType: 'fixture', fields: { roomId: fam, type: 'light', name: 'x' } }] });
  assert.equal(bad.isError, true); assert.match(bad.text, /current_locked/);
  // Michael's own edit in the design works too, and is undone by a rollback.
  const r0 = await rev(D);
  ok(await save(D, [{ op: 'create', entityType: 'fixture', fields: { roomId: fam, type: 'light', name: 'Flush mount' } }]));
  assert.equal(ok(await http('GET', `/api/workspaces/${D}`)).rooms[0].fixtures.length, 3);
  ok(await http('POST', `/api/workspaces/${D}/rollback`, { toRevision: r0 }));
  assert.equal(ok(await http('GET', `/api/workspaces/${D}`)).rooms[0].fixtures.length, 2);
});

test('propose_pieces: wall pieces hang on the wall, the TV is sized by its screen, planCost counts every piece', async () => {
  const before = await prisma.placement.count();
  const r = await mcp('propose_pieces', {
    workspaceId: D, title: 'Moody lighting and art', rationale: 'Low warm pools of light', source: src, cost,
    pieces: [
      { template: 'swag_pendants', roomId: fam, xIn: 200, yIn: 30, params: { count: 3, material: 'rattan', shape: 'globe' }, priceUsd: 150, name: '3 rattan swag pendants' },
      { template: 'framed_art', roomId: fam, wall: { wallId: wallN, offsetIn: 60 }, params: { frameColor: '#3B2F27', mountHeightIn: 60 } },
      { template: 'tv', roomId: fam, wall: { wallId: wallE, offsetIn: 84 }, params: { screenIn: 75 } },
      { template: 'plant', roomId: fam, xIn: 220, yIn: 20, params: { type: 'bird_of_paradise' }, hIn: 72 },
    ],
  });
  assert.equal(r.isError, false, r.text);
  const p = r.data;
  assert.equal(p.status, 'pending');
  assert.equal(await prisma.placement.count(), before); // nothing applied yet
  const items = p.changes.filter((c: any) => c.entityType === 'furniture_item');
  const tv = items.find((c: any) => c.fields.kind === 'tv');
  assert.equal(tv.fields.wIn, '65'); assert.equal(tv.fields.hIn, '37');
  const pls = p.changes.filter((c: any) => c.entityType === 'placement');
  assert.deepEqual([pls[1].fields.xIn, pls[1].fields.yIn, pls[1].fields.rotationDeg], ['60', '1', '180']);
  assert.deepEqual([pls[2].fields.xIn, pls[2].fields.yIn, pls[2].fields.rotationDeg], ['239', '84', '270']);
  // planCost: the priced cluster at its price; art, TV and plant at their typical ranges.
  assert.deepEqual(p.planCost.lines.map((l: any) => l.basis), ['price', 'typical', 'typical', 'typical']);
  assert.equal(p.planCost.lowUsd, 150 + 30 + 300 + 30);
  assert.equal(p.planCost.highUsd, 150 + 400 + 2000 + 350);
  // Bad parameters are refused before anything is stored.
  const bad = await mcp('propose_pieces', { workspaceId: D, title: 'Bad', rationale: 'x', source: src, cost, pieces: [{ template: 'pendant', roomId: fam, xIn: 1, yIn: 1, params: { shape: 'star' } }] });
  assert.equal(bad.isError, true); assert.match(bad.text, /shape must be one of/);
  ok(await http('POST', `/api/proposals/${p.id}/approve`, {}));
  const view = ok(await http('GET', `/api/workspaces/${D}`));
  const art = view.rooms[0].furniture.find((f: any) => f.template?.slug === 'framed_art');
  assert.equal(art.template.params.mountHeightIn, '60'); assert.equal(art.template.params.frameColor, '#3b2f27');
  assert.ok(view.rooms[0].furniture.some((f: any) => f.template?.slug === 'swag_pendants' && f.item.priceCents === 15000));
});

test('ceiling fan swaps for a pendant in a design (replace + replacesPlacementId)', async () => {
  const fan = await mcp('propose_pieces', { workspaceId: D, title: 'Fan', rationale: 'x', source: src, cost, pieces: [{ template: 'ceiling_fan', roomId: fam, xIn: 120, yIn: 84, action: 'existing' }] });
  ok(await http('POST', `/api/proposals/${fan.data.id}/approve`, {}));
  const fanPl = ok(await http('GET', `/api/workspaces/${D}`)).rooms[0].furniture.find((f: any) => f.template?.slug === 'ceiling_fan');
  const swap = await mcp('propose_pieces', { workspaceId: D, title: 'Swap the fan for a pendant', rationale: 'x', source: src, cost,
    pieces: [{ template: 'pendant', roomId: fam, xIn: 120, yIn: 84, replacesPlacementId: fanPl.id, params: { shape: 'ufo_paper', material: 'paper', dropIn: 24 } }],
    changes: [{ op: 'update', entityType: 'placement', entityId: fanPl.id, field: 'action', value: 'replace' }] });
  assert.equal(swap.isError, false, swap.text);
  ok(await http('POST', `/api/proposals/${swap.data.id}/approve`, {}));
  const f = ok(await http('GET', `/api/workspaces/${D}`)).rooms[0].furniture;
  assert.equal(f.find((x: any) => x.id === fanPl.id).action, 'replace');
  assert.equal(f.find((x: any) => x.template?.slug === 'pendant').replacesPlacementId, fanPl.id);
});

test('wall color and finish per wall: design, copy, Save to Current, rollback', async () => {
  const pr = await mcp('propose_wall_finish', { workspaceId: D, roomId: fam, title: 'Limewash media wall', rationale: 'Texture', source: src, cost,
    walls: [{ wallId: wallE, color: '#5A4A3F', colorName: 'Roman Clay Umber', finish: 'limewash' }] });
  assert.equal(pr.isError, false, pr.text);
  assert.deepEqual(pr.data.planCost.lines.map((l: any) => l.what), ['Limewash one wall']);
  const notMine = await mcp('propose_wall_finish', { workspaceId: D, roomId: fam, title: 'x', rationale: 'x', source: src, cost, walls: [{ wallId: 999999, color: '#000000' }] });
  assert.equal(notMine.isError, true);
  ok(await http('POST', `/api/proposals/${pr.data.id}/approve`, {}));
  let walls = ok(await http('GET', `/api/workspaces/${D}`)).rooms[0].walls;
  const e = walls.find((w: any) => w.id === wallE);
  assert.deepEqual([e.style.color, e.style.finish, e.style.colorName], ['#5a4a3f', 'limewash', 'Roman Clay Umber']);
  assert.equal(walls.find((w: any) => w.id === wallN).style, null);
  // Michael's own edit: an accent color on the north wall.
  ok(await save(D, [{ op: 'create', entityType: 'wall_style', fields: { wallId: wallN, color: '#2F3A33', finish: 'paint' } }]));
  const dup = await save(D, [{ op: 'create', entityType: 'wall_style', fields: { wallId: wallN, color: '#000000' } }]);
  assert.equal(dup.status, 409);
  // Current is unchanged; a copy keeps the walls.
  assert.ok(ok(await http('GET', '/api/house')).current.rooms[0].walls.every((w: any) => w.style === null));
  const copy = ok(await http('POST', '/api/workspaces', { name: 'Moody den copy', copyFromWorkspaceId: D }), 201);
  assert.equal(copy.rooms[0].walls.filter((w: any) => w.style).length, 2);
  // Save to Current carries the wall finishes (with the furniture marked existing/keep).
  const sum = ok(await http('GET', `/api/workspaces/${D}/save-to-current`));
  assert.equal(sum.wallColors.set.length, 2);
  const curBefore = (await prisma.house.findFirstOrThrow()).currentRevision!;
  ok(await http('POST', `/api/workspaces/${D}/save-to-current`, { revision: sum.revision }), 201);
  walls = ok(await http('GET', '/api/house')).current.rooms[0].walls;
  assert.equal(walls.find((w: any) => w.id === wallE).style.finish, 'limewash');
  // Rolled back from History, Current's walls are plain again.
  ok(await http('POST', '/api/current/rollback', { toRevision: curBefore }));
  assert.ok(ok(await http('GET', '/api/house')).current.rooms[0].walls.every((w: any) => w.style === null));
  // A proposal can set a wall finish for Current directly (it is a color, like room_style).
  const cur = await mcp('propose_wall_finish', { current: true, roomId: fam, title: 'Accent wall now', rationale: 'From photos', source: src, cost, walls: [{ wallId: wallN, color: '#2F3A33' }] });
  assert.equal(cur.isError, false, cur.text);
});

test('migration 0009 gives existing designs a copy of Current\'s fixtures', async () => {
  assert.equal(ok(await http('GET', `/api/workspaces/${oldDesign}`)).rooms[0].fixtures.length, 0);
  const sql = readFileSync('prisma/migrations/0009_mood_templates_wall_styles/migration.sql', 'utf8');
  await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('INSERT INTO `fixtures`')));
  const fx = ok(await http('GET', `/api/workspaces/${oldDesign}`)).rooms[0].fixtures;
  assert.deepEqual(fx.map((f: any) => [f.name, f.workspaceId]), [['Black ceiling fan', oldDesign]]);
  assert.deepEqual(ok(await http('GET', '/api/house')).current.rooms[0].fixtures.map((f: any) => f.id), [fanFixture]);
});
