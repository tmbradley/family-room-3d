import { test } from 'node:test';
import assert from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { createScanImport, promoteScanImport, rejectScanImport, type CapturedRoom } from '../server/scans.js';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL environment variable is required for tests. Never use DATABASE_URL for testing.');
}
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });

// Sample scan data - Real Apple RoomPlan format
const sampleScan: CapturedRoom = {
  dimensions: [3.6576, 3.9624, 2.7432],
  walls: [
    { identifier: 'w1', category: 'wall', dimensions: [3.6576, 0.127, 2.7432], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], confidence: 'high' },
    { identifier: 'w2', category: 'wall', dimensions: [3.9624, 0.127, 2.7432], transform: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 3.6576, 0, 0, 1], confidence: 'high' },
    { identifier: 'w3', category: 'wall', dimensions: [3.6576, 0.127, 2.7432], transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 3.6576, 0, 3.9624, 1], confidence: 'high' },
    { identifier: 'w4', category: 'wall', dimensions: [3.9624, 0.127, 2.7432], transform: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 3.9624, 1], confidence: 'high' },
  ],
  doors: [],
  windows: [
    { identifier: 'win1', parentIdentifier: 'w3', category: 'window', dimensions: [1.524, 1.2192], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.2192, 1.2192, 0, 1], confidence: 'medium' },
  ],
  openings: [],
  objects: [],
};

test('promoteScanImport creates Current room from scan', async () => {
  // Create house and upload
  const house = await prisma.house.create({ data: { name: 'Test House' } });
  const upload = await prisma.upload.create({
    data: {
      houseId: house.id,
      kind: 'scan',
      format: 'roomplan_json',
      bucketKey: 'test.json',
      status: 'uploaded',
      uploadedBy: 'system',
    },
  });

  // Create scan import
  const scanImport = await createScanImport({
    houseId: house.id,
    uploadId: upload.id,
    roomplanData: sampleScan,
    label: 'Test Room',
  });

  // Promote to Current
  const result = await promoteScanImport(scanImport.id, 'michael');
  assert.ok(result.success);
  assert.ok(result.roomId);

  // Verify room was created
  const room = await prisma.room.findUnique({ where: { id: result.roomId } });
  assert.ok(room);
  assert.strictEqual(room?.label, 'Test Room');
  assert.strictEqual(room?.draftWorkspaceId, null); // Current room
  assert.strictEqual(room?.measurementStatus, 'scan');

  // Verify walls were created
  const walls = await prisma.wall.findMany({ where: { roomId: room!.id } });
  assert.strictEqual(walls.length, 4);
  assert.ok(walls.every(w => w.measurementStatus === 'scan'));

  // Verify measurements were recorded
  const measurements = await prisma.measurement.findMany({
    where: { source: 'scan', uploadId: upload.id },
  });
  assert.ok(measurements.length > 0);

  // Verify revision was created
  const revision = await prisma.revision.findUnique({ where: { id: result.revisionId } });
  assert.ok(revision);
  assert.strictEqual(revision?.kind, 'rescan');
  assert.strictEqual(revision?.scope, 'current');

  // Verify house currentRevision was set
  const updatedHouse = await prisma.house.findUnique({ where: { id: house.id } });
  assert.strictEqual(updatedHouse?.currentRevision, result.revisionId);

  // Cleanup
  await prisma.house.delete({ where: { id: house.id } });
});

test('promoteScanImport respects pinned measurements', async () => {
  // Create house and upload
  const house = await prisma.house.create({ data: { name: 'Test House with Pins' } });
  const upload = await prisma.upload.create({
    data: {
      houseId: house.id,
      kind: 'scan',
      format: 'roomplan_json',
      bucketKey: 'test2.json',
      status: 'uploaded',
      uploadedBy: 'system',
    },
  });

  // Create scan import
  const scanImport = await createScanImport({
    houseId: house.id,
    uploadId: upload.id,
    roomplanData: sampleScan,
    label: 'Test Room with Pins',
  });

  // Promote first time to create room
  const firstPromotion = await promoteScanImport(scanImport.id, 'michael');
  const roomId = firstPromotion.roomId!;

  // Pin a ceiling height measurement
  const pinnedValue = 110; // Different from scan value of 108
  await prisma.measurement.create({
    data: {
      entityType: 'room',
      entityId: roomId,
      field: 'ceilingIn',
      valueIn: pinnedValue,
      source: 'manual',
      isOverride: true,
      recordedBy: 'michael',
      note: 'Manually measured and pinned',
    },
  });

  // Create second scan import (rescan)
  const upload2 = await prisma.upload.create({
    data: {
      houseId: house.id,
      kind: 'scan',
      format: 'roomplan_json',
      bucketKey: 'test3.json',
      status: 'uploaded',
      uploadedBy: 'system',
    },
  });

  const scanImport2 = await createScanImport({
    houseId: house.id,
    uploadId: upload2.id,
    roomplanData: sampleScan,
    label: 'Rescan Test Room',
  });

  // Promote second scan
  await promoteScanImport(scanImport2.id, 'michael');

  // Verify the pinned value was preserved
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  assert.strictEqual(room?.ceilingIn, pinnedValue, 'Pinned value should be preserved');

  // Verify scan measurement was still recorded
  const scanMeasurements = await prisma.measurement.findMany({
    where: {
      entityType: 'room',
      entityId: roomId,
      field: 'ceilingIn',
      source: 'scan',
      uploadId: upload2.id,
    },
  });
  assert.strictEqual(scanMeasurements.length, 1);
  assert.ok(scanMeasurements[0].note?.includes('pinned'));

  // Cleanup
  await prisma.house.delete({ where: { id: house.id } });
});

test('rejectScanImport marks scan as rejected', async () => {
  // Create house and upload
  const house = await prisma.house.create({ data: { name: 'Test House Reject' } });
  const upload = await prisma.upload.create({
    data: {
      houseId: house.id,
      kind: 'scan',
      format: 'roomplan_json',
      bucketKey: 'test-reject.json',
      status: 'uploaded',
      uploadedBy: 'system',
    },
  });

  // Create scan import
  const scanImport = await createScanImport({
    houseId: house.id,
    uploadId: upload.id,
    roomplanData: sampleScan,
    label: 'Bad Scan',
  });

  // Reject the scan
  await rejectScanImport(scanImport.id, 'Scan quality too low');

  // Verify status
  const updated = await prisma.scanImport.findUnique({ where: { id: scanImport.id } });
  assert.strictEqual(updated?.status, 'rejected');
  assert.strictEqual(updated?.notes, 'Scan quality too low');

  // Verify no room was created
  const rooms = await prisma.room.count({ where: { houseId: house.id } });
  assert.strictEqual(rooms, 0);

  // Cleanup
  await prisma.house.delete({ where: { id: house.id } });
});

test('promoteScanImport fails if already processed', async () => {
  // Create house and upload
  const house = await prisma.house.create({ data: { name: 'Test House Double' } });
  const upload = await prisma.upload.create({
    data: {
      houseId: house.id,
      kind: 'scan',
      format: 'roomplan_json',
      bucketKey: 'test-double.json',
      status: 'uploaded',
      uploadedBy: 'system',
    },
  });

  // Create scan import
  const scanImport = await createScanImport({
    houseId: house.id,
    uploadId: upload.id,
    roomplanData: sampleScan,
    label: 'Double Test',
  });

  // Promote once
  await promoteScanImport(scanImport.id, 'michael');

  // Try to promote again - should fail
  await assert.rejects(
    async () => await promoteScanImport(scanImport.id, 'michael'),
    {
      message: /already been promoted/,
    }
  );

  // Cleanup
  await prisma.house.delete({ where: { id: house.id } });
});

test('promoteScanImport creates measurements with scan source', async () => {
  // Create house and upload
  const house = await prisma.house.create({ data: { name: 'Test Measurements' } });
  const upload = await prisma.upload.create({
    data: {
      houseId: house.id,
      kind: 'scan',
      format: 'roomplan_json',
      bucketKey: 'test-meas.json',
      status: 'uploaded',
      uploadedBy: 'system',
    },
  });

  // Create scan import
  const scanImport = await createScanImport({
    houseId: house.id,
    uploadId: upload.id,
    roomplanData: sampleScan,
    label: 'Measurement Test',
  });

  // Promote
  const result = await promoteScanImport(scanImport.id, 'michael');

  // Verify all measurements have scan source
  const measurements = await prisma.measurement.findMany({
    where: { uploadId: upload.id },
  });
  assert.ok(measurements.length > 0);
  assert.ok(measurements.every(m => m.source === 'scan'));

  // Verify walls have measurements
  const wallMeasurements = await prisma.measurement.findMany({
    where: { entityType: 'wall', uploadId: upload.id },
  });
  assert.ok(wallMeasurements.length >= 4 * 4); // 4 walls × at least 4 fields each

  // Cleanup
  await prisma.house.delete({ where: { id: house.id } });
});

// Clean up
test.after(async () => {
  await prisma.$disconnect();
});
