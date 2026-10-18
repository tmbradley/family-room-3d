/**
 * RoomPlan parser tests against Apple's CapturedRoom Codable layout (keyed-enum categories,
 * simd_float3 dimensions with height at [1], column-major 4x4 transforms, parentIdentifier).
 * Fixtures are synthetic rooms built in that layout (fixtures/roomplan-builder.mjs), plus one wall
 * copied verbatim from a published CapturedRoom JSON sample.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
await import('./helpers.js');
const { parseCapturedRoom, alignToRoom } = await import('../server/scans.js');
// @ts-ignore plain JS module
const { buildCapturedRoom, SAMPLE, uuid } = await import('../fixtures/roomplan-builder.mjs');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-roomplan.json', import.meta.url), 'utf8'));

test('sample fixture is in RoomPlan layout and parses to a squared 12x13 room', () => {
  assert.deepEqual(fixture.walls[0].category, { wall: {} });
  assert.deepEqual(fixture.doors[0].category, { door: { isOpen: false } });
  assert.equal(fixture.walls[0].dimensions.length, 3);
  assert.equal(fixture.walls[0].dimensions[2], 0);
  assert.equal(fixture.walls[0].transform.length, 16);
  const r = parseCapturedRoom(fixture);
  assert.equal(r.widthIn, 144);
  assert.equal(r.depthIn, 156);
  assert.equal(r.ceilingIn, 108);
  assert.equal(r.alignedByDeg, -30); // the session was turned 30° counterclockwise seen from above (about +Y)
  assert.deepEqual(r.walls.map((w) => [w.startXIn, w.startYIn, w.endXIn, w.endYIn, w.heightIn]), [
    [0, 0, 144, 0, 108], [144, 0, 144, 156, 108], [144, 156, 0, 156, 108], [0, 156, 0, 0, 108],
  ]);
});

test('openings: parent wall from parentIdentifier, offset along the wall, sill/head from height', () => {
  const r = parseCapturedRoom(fixture);
  const by = Object.fromEntries(r.openings.map((o) => [o.type, o]));
  assert.deepEqual(by.window, { key: uuid(12), wallKey: uuid(1), type: 'window', offsetIn: 42, widthIn: 60, sillIn: 36, headIn: 84 });
  assert.deepEqual(by.door, { key: uuid(11), wallKey: uuid(4), type: 'door', offsetIn: 24, widthIn: 36, sillIn: 0, headIn: 80 });
  assert.deepEqual(by.open_span, { key: uuid(13), wallKey: uuid(2), type: 'open_span', offsetIn: 40, widthIn: 72, sillIn: 0, headIn: 84 });
});

test('objects: category from the keyed enum, dimensions [width, height, depth]', () => {
  const r = parseCapturedRoom(fixture);
  const sofa = r.objects.find((o) => o.kind === 'sofa')!;
  assert.deepEqual({ ...sofa, key: undefined }, { key: undefined, kind: 'sofa', xIn: 72, yIn: 120, rotationDeg: 0, widthIn: 84, heightIn: 34, depthIn: 36 });
  assert.ok(r.objects.some((o) => o.kind === 'table'));
});

test('a wall copied from a published CapturedRoom sample: length = dimensions[0], height = dimensions[1]', () => {
  const r = parseCapturedRoom({
    walls: [{
      completedEdges: [], story: 0, curve: null, identifier: '1786EBF8-1C92-486A-9B99-D6168FDF6052', parentIdentifier: null,
      confidence: { high: {} }, category: { wall: {} }, dimensions: [2.6529655, 2.415, 0],
      transform: [-0.50751626, 0, 0.8616421, 0, 0, 1, 0, 0, 0.8616421, 0, 0.50751626, 0, -0.49793836, -0.16968237, -0.6089062, 1],
      polygonCorners: [],
    }],
    doors: [], windows: [], openings: [], objects: [],
  });
  const w = r.walls[0];
  assert.equal(w.lengthIn, 104);
  assert.equal(w.heightIn, 95);
  assert.equal(Math.round(Math.hypot(w.endXIn - w.startXIn, w.endYIn - w.startYIn)), 104);
  // Squared to an axis.
  assert.ok(w.startXIn === w.endXIn || w.startYIn === w.endYIn);
});

test('same room scanned from a different heading and position parses to the same plan (up to a quarter turn)', () => {
  const a = parseCapturedRoom(fixture);
  const b = parseCapturedRoom(buildCapturedRoom({ ...SAMPLE, yawDeg: 123, origin: { x: -4.2, z: 2.9 }, floorY: -1.45 }));
  assert.equal(b.ceilingIn, 108);
  const { walls, quarterTurns } = alignToRoom(b.walls, a.walls);
  assert.ok(quarterTurns >= 0);
  for (const w of a.walls) {
    const near = walls.some((x) => [[x.startXIn, x.startYIn, x.endXIn, x.endYIn]].some(([sx, sy, ex, ey]) =>
      Math.abs(sx - w.startXIn) <= 1 && Math.abs(sy - w.startYIn) <= 1 && Math.abs(ex - w.endXIn) <= 1 && Math.abs(ey - w.endYIn) <= 1));
    assert.ok(near, `wall ${JSON.stringify(w)} not found after alignment`);
  }
});

test('iOS 16 scans without parentIdentifier attach openings to the nearest wall', () => {
  const r = parseCapturedRoom(buildCapturedRoom({ ...SAMPLE, parents: false }));
  const win = r.openings.find((o) => o.type === 'window')!;
  assert.equal(win.wallKey, uuid(1));
  assert.equal(win.offsetIn, 42);
});

test('rejects data that is not a CapturedRoom', () => {
  assert.throws(() => parseCapturedRoom({ dimensions: [3, 3, 3] }), /Not a RoomPlan CapturedRoom/);
  assert.throws(() => parseCapturedRoom({ walls: [{ identifier: 'w', category: { wall: {} }, dimensions: [1, 2], transform: [1] }] }), /Not a RoomPlan CapturedRoom/);
  assert.throws(() => parseCapturedRoom('not json'), /Not a RoomPlan CapturedRoom/);
});

test('plan is the room seen from above, not a mirror image: world -Z (forward) is plan +y', () => {
  // Square 4 m x 3 m room on the world axes, from (0, 0) forward to z = -3 (RoomPlan: right-handed, y up,
  // -Z is forward). A sofa near the far-left corner, facing the user (+Z), and a TV on the right wall.
  const room = buildCapturedRoom({ yawDeg: 0, origin: { x: 0, z: 0 }, walls: [[0, 0, 157, 0], [157, 0, 157, 118], [157, 118, 0, 118], [0, 118, 0, 0]],
    objects: [{ cat: 'sofa', x: 0, z: 0, w: 84, h: 34, d: 36 }, { cat: 'television', x: 0, z: 0, w: 50, h: 30, d: 4 }] });
  const M = 1 / 0.0254;
  // Overwrite the object transforms with hand-written world poses (independent of the builder's mapping).
  room.objects[0].transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.0, -0.8, -2.5, 1];        // local x = +X, front (+z) = +Z
  room.objects[1].transform = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 3.9, 0.2, -1.5, 1];       // local x = +Z: turned -90° about Y
  // Walls must be in the same world frame: check the builder put them at z in [-3, 0].
  const zs = room.walls.map((w: any) => w.transform[14]);
  assert.ok(Math.min(...zs) < -2.9 && Math.max(...zs) <= 0.001, 'walls run forward (-Z)');
  const r = parseCapturedRoom(room);
  assert.equal(r.alignedByDeg, 0);
  const [sofa, tv] = r.objects;
  assert.equal(sofa.xIn, Math.round(1.0 * M));
  assert.equal(sofa.yIn, Math.round(2.5 * M), 'far (forward) side of the room is plan +y, i.e. the top of the top view');
  assert.equal(sofa.rotationDeg, 0);
  assert.equal(tv.xIn, Math.round(3.9 * M)); assert.equal(tv.yIn, Math.round(1.5 * M));
  // Local x along +Z (toward the user) is plan -y: 270° counterclockwise, i.e. three.js rotation.y = 270°.
  assert.equal(tv.rotationDeg, 270);
});
