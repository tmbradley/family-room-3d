import { test } from 'node:test';
import assert from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { parseCapturedRoom, type CapturedRoom } from '../server/scans.js';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL environment variable is required for tests. Never use DATABASE_URL for testing.');
}
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });

// Sample CapturedRoom fixture - Real Apple RoomPlan format
const sampleCapturedRoom: CapturedRoom = {
  dimensions: [3.6576, 3.9624, 2.7432], // [width, length, height] in meters
  walls: [
    {
      identifier: 'wall-0',
      category: 'wall',
      dimensions: [3.6576, 0.127, 2.7432],
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      confidence: 'high',
    },
    {
      identifier: 'wall-1',
      category: 'wall',
      dimensions: [3.9624, 0.127, 2.7432],
      transform: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 3.6576, 0, 0, 1],
      confidence: 'high',
    },
    {
      identifier: 'wall-2',
      category: 'wall',
      dimensions: [3.6576, 0.127, 2.7432],
      transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 3.6576, 0, 3.9624, 1],
      confidence: 'high',
    },
    {
      identifier: 'wall-3',
      category: 'wall',
      dimensions: [3.9624, 0.127, 2.7432],
      transform: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 3.9624, 1],
      confidence: 'high',
    },
  ],
  doors: [
    {
      identifier: 'door-0',
      parentIdentifier: 'wall-3',
      category: 'door',
      dimensions: [0.9144, 2.0320], // [width, height] ~3 ft × 6.67 ft
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.9144, 0, 1.9812, 1],
      confidence: 'medium',
    },
  ],
  windows: [
    {
      identifier: 'window-0',
      parentIdentifier: 'wall-2',
      category: 'window',
      dimensions: [1.524, 1.2192], // [width, height] ~5 ft × 4 ft
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.2192, 1.2192, 0, 1],
      confidence: 'high',
    },
  ],
  openings: [],
  objects: [
    {
      identifier: 'sofa-0',
      category: 'sofa',
      dimensions: [2.1336, 0.9144, 0.8382], // ~7 ft × 3 ft × 2.75 ft
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.8288, 0.4191, 0.6096, 1],
      confidence: 'medium',
    },
    {
      identifier: 'table-0',
      category: 'table',
      dimensions: [1.2192, 0.6096, 0.4572], // ~4 ft × 2 ft × 1.5 ft
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.8288, 0.2286, 1.8288, 1],
      confidence: 'medium',
    },
  ],
};

test('parseCapturedRoom converts meters to inches', () => {
  const parsed = parseCapturedRoom(sampleCapturedRoom);

  // Check room dimensions (meters to inches)
  assert.strictEqual(parsed.widthIn, 144); // ~12 feet
  assert.strictEqual(parsed.depthIn, 156); // ~13 feet
  assert.strictEqual(parsed.ceilingIn, 108); // ~9 feet
});

test('parseCapturedRoom extracts walls', () => {
  const parsed = parseCapturedRoom(sampleCapturedRoom);

  assert.strictEqual(parsed.walls.length, 4);
  assert.ok(parsed.walls.every(w => w.heightIn > 0));
  assert.ok(parsed.walls.every(w => w.thicknessIn === 5)); // default thickness
});

test('parseCapturedRoom extracts openings', () => {
  const parsed = parseCapturedRoom(sampleCapturedRoom);

  assert.strictEqual(parsed.openings.length, 2);
  
  const window = parsed.openings.find(o => o.type === 'window');
  assert.ok(window);
  assert.ok(window.widthIn > 0);
  assert.ok(window.sillIn >= 0);
  assert.ok(window.headIn > window.sillIn);

  const door = parsed.openings.find(o => o.type === 'door');
  assert.ok(door);
  assert.ok(door.widthIn > 0);
});

test('parseCapturedRoom extracts objects', () => {
  const parsed = parseCapturedRoom(sampleCapturedRoom);

  assert.strictEqual(parsed.objects.length, 2);

  const sofa = parsed.objects.find(o => o.kind === 'sofa');
  assert.ok(sofa);
  assert.ok(sofa.widthIn > 0);
  assert.ok(sofa.depthIn > 0);
  assert.ok(sofa.heightIn > 0);

  const table = parsed.objects.find(o => o.kind === 'table');
  assert.ok(table);
  assert.ok(table.widthIn > 0);
});

test('parseCapturedRoom respects custom label', () => {
  const parsed = parseCapturedRoom(sampleCapturedRoom, 'Family Room');
  assert.strictEqual(parsed.label, 'Family Room');
});

test('parseCapturedRoom uses default label', () => {
  const parsed = parseCapturedRoom(sampleCapturedRoom);
  assert.strictEqual(parsed.label, 'Scanned Room');
});

// Clean up
test.after(async () => {
  await prisma.$disconnect();
});
