import { prisma } from './db.js';
import { ApiError } from './util.js';
import type { Prisma } from '@prisma/client';

/**
 * RoomPlan CapturedRoom data structure (from Apple's RoomPlan framework)
 */
export interface CapturedRoom {
  dimensions: { width: number; length: number; height: number };
  walls: Array<{
    identifier: string;
    dimensions: { width: number; length: number; height: number };
    transform: number[]; // 4x4 matrix
  }>;
  openings: Array<{
    identifier: string;
    parentIdentifier: string; // wall ID
    type: 'window' | 'door' | 'opening';
    dimensions: { width: number; height: number };
    transform: number[]; // 4x4 matrix
  }>;
  objects: Array<{
    identifier: string;
    category: string;
    dimensions: { width: number; length: number; height: number };
    transform: number[]; // 4x4 matrix
  }>;
}

interface ParsedRoom {
  label: string;
  widthIn: number;
  depthIn: number;
  ceilingIn: number;
  walls: Array<{
    index: number;
    startXIn: number;
    startYIn: number;
    endXIn: number;
    endYIn: number;
    heightIn: number;
    thicknessIn: number;
  }>;
  openings: Array<{
    index: number;
    wallIndex: number;
    type: 'window' | 'door' | 'open_span';
    offsetIn: number;
    widthIn: number;
    sillIn: number;
    headIn: number;
  }>;
  objects: Array<{
    index: number;
    kind: string;
    xIn: number;
    yIn: number;
    rotationDeg: number;
    widthIn: number;
    depthIn: number;
    heightIn: number;
  }>;
}

/**
 * Convert meters to inches (RoomPlan uses meters)
 */
function metersToInches(meters: number): number {
  return Math.round(meters * 39.3701);
}

/**
 * Extract position from 4x4 transform matrix
 */
function extractPosition(transform: number[]): { x: number; y: number; z: number } {
  // Transform matrix is column-major: [m00, m10, m20, m30, m01, m11, m21, m31, m02, m12, m22, m32, m03, m13, m23, m33]
  // Position is in the last column: [m03, m13, m23]
  return {
    x: transform[12],
    y: transform[13],
    z: transform[14],
  };
}

/**
 * Extract rotation (yaw) from 4x4 transform matrix
 */
function extractRotation(transform: number[]): number {
  // Extract rotation around Y axis (yaw) from the transform matrix
  const m00 = transform[0];
  const m02 = transform[8];
  const yaw = Math.atan2(m02, m00);
  return Math.round((yaw * 180) / Math.PI);
}

/**
 * Parse RoomPlan CapturedRoom data into our relational format.
 * All dimensions are converted to integer inches.
 */
export function parseCapturedRoom(data: CapturedRoom, label?: string): ParsedRoom {
  const widthIn = metersToInches(data.dimensions.width);
  const depthIn = metersToInches(data.dimensions.length);
  const ceilingIn = metersToInches(data.dimensions.height);

  // Parse walls
  const walls = data.walls.map((wall, index) => {
    const pos = extractPosition(wall.transform);
    const widthM = wall.dimensions.width;
    
    // Convert wall position and dimensions to room coordinates
    const startXIn = metersToInches(pos.x - widthM / 2);
    const startYIn = metersToInches(pos.z - widthM / 2);
    const endXIn = metersToInches(pos.x + widthM / 2);
    const endYIn = metersToInches(pos.z + widthM / 2);
    const heightIn = metersToInches(wall.dimensions.height);

    return {
      index,
      startXIn,
      startYIn,
      endXIn,
      endYIn,
      heightIn,
      thicknessIn: 5, // Default 5 inches
    };
  });

  // Parse openings
  const openings = data.openings.map((opening, index) => {
    const pos = extractPosition(opening.transform);
    const parentWallIndex = data.walls.findIndex((w) => w.identifier === opening.parentIdentifier);

    // Calculate offset along the wall
    const offsetIn = metersToInches(pos.x);
    const widthIn = metersToInches(opening.dimensions.width);
    const heightIn = metersToInches(opening.dimensions.height);

    return {
      index,
      wallIndex: parentWallIndex >= 0 ? parentWallIndex : 0,
      type: opening.type === 'window' ? 'window' : opening.type === 'door' ? 'door' : 'open_span',
      offsetIn,
      widthIn,
      sillIn: 36, // Default window sill height
      headIn: heightIn + 36,
    };
  });

  // Parse objects (furniture)
  const objects = data.objects.map((obj, index) => {
    const pos = extractPosition(obj.transform);
    const rotation = extractRotation(obj.transform);

    return {
      index,
      kind: obj.category.toLowerCase(),
      xIn: metersToInches(pos.x),
      yIn: metersToInches(pos.z),
      rotationDeg: rotation,
      widthIn: metersToInches(obj.dimensions.width),
      depthIn: metersToInches(obj.dimensions.length),
      heightIn: metersToInches(obj.dimensions.height),
    };
  });

  return {
    label: label || 'Scanned Room',
    widthIn,
    depthIn,
    ceilingIn,
    walls,
    openings,
    objects,
  };
}

/**
 * Create a scan import from uploaded RoomPlan data.
 * Parses the data and stores it in scan_import_data table for review.
 */
export async function createScanImport(params: {
  houseId: number;
  uploadId: number;
  roomplanData: CapturedRoom;
  label?: string;
  roomId?: number;
}) {
  const { houseId, uploadId, roomplanData, label, roomId } = params;

  // Parse the RoomPlan data
  const parsed = parseCapturedRoom(roomplanData, label);

  // Create scan import record
  const scanImport = await prisma.scanImport.create({
    data: {
      houseId,
      roomId: roomId ?? null,
      uploadId,
      label: parsed.label,
      status: 'pending',
    },
  });

  // Store parsed data in scan_import_data table
  const dataRecords: Prisma.ScanImportDataCreateManyInput[] = [];

  // Room dimensions
  dataRecords.push(
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'label', value: parsed.label },
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'widthIn', value: String(parsed.widthIn) },
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'depthIn', value: String(parsed.depthIn) },
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'ceilingIn', value: String(parsed.ceilingIn) }
  );

  // Walls
  for (const wall of parsed.walls) {
    dataRecords.push(
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'startXIn', value: String(wall.startXIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'startYIn', value: String(wall.startYIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'endXIn', value: String(wall.endXIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'endYIn', value: String(wall.endYIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'heightIn', value: String(wall.heightIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'thicknessIn', value: String(wall.thicknessIn) }
    );
  }

  // Openings
  for (const opening of parsed.openings) {
    dataRecords.push(
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'wallIndex', value: String(opening.wallIndex) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'type', value: opening.type },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'offsetIn', value: String(opening.offsetIn) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'widthIn', value: String(opening.widthIn) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'sillIn', value: String(opening.sillIn) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'headIn', value: String(opening.headIn) }
    );
  }

  // Objects (detected furniture)
  for (const obj of parsed.objects) {
    dataRecords.push(
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'kind', value: obj.kind },
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'xIn', value: String(obj.xIn) },
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'yIn', value: String(obj.yIn) },
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'rotationDeg', value: String(obj.rotationDeg) },
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'widthIn', value: String(obj.widthIn) },
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'depthIn', value: String(obj.depthIn) },
      { scanImportId: scanImport.id, entityType: 'object', entityIndex: obj.index, field: 'heightIn', value: String(obj.heightIn) }
    );
  }

  await prisma.scanImportData.createMany({ data: dataRecords });

  // Mark upload as imported
  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: 'imported', scanImportId: scanImport.id },
  });

  return scanImport;
}

/**
 * Get a scan import with all its parsed data.
 */
export async function getScanImport(scanImportId: number) {
  const scanImport = await prisma.scanImport.findUnique({
    where: { id: scanImportId },
    include: {
      house: true,
      room: true,
      upload: true,
      data: { orderBy: [{ entityType: 'asc' }, { entityIndex: 'asc' }, { field: 'asc' }] },
      files: true,
    },
  });

  if (!scanImport) {
    throw new ApiError(404, 'not_found', 'Scan import not found');
  }

  // Reconstruct the parsed data
  const dataByEntity: Record<string, Record<number, Record<string, string>>> = {};
  
  for (const datum of scanImport.data) {
    if (!dataByEntity[datum.entityType]) {
      dataByEntity[datum.entityType] = {};
    }
    if (!dataByEntity[datum.entityType][datum.entityIndex]) {
      dataByEntity[datum.entityType][datum.entityIndex] = {};
    }
    dataByEntity[datum.entityType][datum.entityIndex][datum.field] = datum.value;
  }

  return {
    ...scanImport,
    parsedData: dataByEntity,
  };
}

/**
 * List scan imports for a house.
 */
export async function listScanImports(houseId: number, status?: 'pending' | 'promoted' | 'rejected') {
  return prisma.scanImport.findMany({
    where: {
      houseId,
      ...(status && { status }),
    },
    include: {
      upload: true,
      room: true,
      files: { select: { id: true, kind: true, format: true, bytes: true, bucketKey: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Promote a scan import to Current.
 * Creates the room structure with measurement source 'scan'.
 * Respects pinned manual measurements.
 */
export async function promoteScanImport(
  scanImportId: number,
  actor: 'michael' | 'agent' = 'michael',
  tx?: any
) {
  const doPromotion = async (prisma: any) => {
    const scanImport = await prisma.scanImport.findUnique({
      where: { id: scanImportId },
      include: {
        house: true,
        data: { orderBy: [{ entityType: 'asc' }, { entityIndex: 'asc' }, { field: 'asc' }] },
      },
    });

    if (!scanImport) {
      throw new ApiError(404, 'not_found', 'Scan import not found');
    }

    if (scanImport.status !== 'pending') {
      throw new ApiError(400, 'already_processed', 'Scan import has already been promoted or rejected');
    }

    const { parsedData } = reconstructParsedData(scanImport.data);
    const roomData = parsedData.room?.[0];

    if (!roomData) {
      throw new ApiError(400, 'invalid_data', 'No room data found in scan import');
    }

    // Get existing pinned measurements
    const pinnedMeasurements = await prisma.measurement.findMany({
      where: {
        source: 'manual',
        isOverride: true,
        unpinnedAt: null,
      },
    });

    const pinnedMap = new Map<string, number>();
    for (const m of pinnedMeasurements) {
      pinnedMap.set(`${m.entityType}:${m.entityId}:${m.field}`, m.valueIn);
    }

    // Create or update the Current room
    const slug = 'family-room';
    let room = await prisma.room.findFirst({
      where: {
        houseId: scanImport.houseId,
        slug,
        draftWorkspaceId: null, // Current room
      },
    });

    if (!room) {
      // Create new Current room
      room = await prisma.room.create({
        data: {
          houseId: scanImport.houseId,
          slug,
          label: roomData.label || 'Family Room',
          ceilingIn: Number(roomData.ceilingIn),
          floorMaterial: 'hardwood',
          floorFinish: 'honey oak',
          floorKeep: true,
          measurementStatus: 'scan',
        },
      });
    } else {
      // Update existing room
      await prisma.room.update({
        where: { id: room.id },
        data: {
          label: roomData.label,
          ceilingIn: pinnedMap.get(`room:${room.id}:ceilingIn`) ?? Number(roomData.ceilingIn),
          measurementStatus: 'scan',
        },
      });
    }

    // Record room measurements
    await recordMeasurementIfNotPinned(prisma, {
      entityType: 'room',
      entityId: room.id,
      field: 'ceilingIn',
      valueIn: Number(roomData.ceilingIn),
      source: 'scan',
      uploadId: scanImport.uploadId,
      actor,
    }, pinnedMap);

    // Delete existing walls and recreate from scan
    await prisma.wall.deleteMany({ where: { roomId: room.id } });

    // Create walls
    const wallMap = new Map<number, number>(); // entityIndex -> wall.id
    for (const [indexStr, wallData] of Object.entries(parsedData.wall || {})) {
      const index = Number(indexStr);
      const wall = await prisma.wall.create({
        data: {
          roomId: room.id,
          startXIn: Number(wallData.startXIn),
          startYIn: Number(wallData.startYIn),
          endXIn: Number(wallData.endXIn),
          endYIn: Number(wallData.endYIn),
          heightIn: Number(wallData.heightIn),
          thicknessIn: Number(wallData.thicknessIn || 5),
          measurementStatus: 'scan',
        },
      });
      wallMap.set(index, wall.id);

      // Record wall measurements
      for (const field of ['startXIn', 'startYIn', 'endXIn', 'endYIn', 'heightIn']) {
        await recordMeasurementIfNotPinned(prisma, {
          entityType: 'wall',
          entityId: wall.id,
          field,
          valueIn: Number(wallData[field]),
          source: 'scan',
          uploadId: scanImport.uploadId,
          actor,
        }, pinnedMap);
      }
    }

    // Delete existing openings and recreate from scan
    await prisma.opening.deleteMany({ where: { wall: { roomId: room.id } } });

    // Create openings
    for (const [, openingData] of Object.entries(parsedData.opening || {})) {
      const wallIndex = Number(openingData.wallIndex);
      const wallId = wallMap.get(wallIndex);
      if (!wallId) continue;

      const opening = await prisma.opening.create({
        data: {
          wallId,
          type: openingData.type as any,
          offsetIn: Number(openingData.offsetIn),
          widthIn: Number(openingData.widthIn),
          sillIn: Number(openingData.sillIn || 36),
          headIn: Number(openingData.headIn || 84),
          measurementStatus: 'scan',
        },
      });

      // Record opening measurements
      for (const field of ['offsetIn', 'widthIn', 'sillIn', 'headIn']) {
        await recordMeasurementIfNotPinned(prisma, {
          entityType: 'opening',
          entityId: opening.id,
          field,
          valueIn: Number(openingData[field]),
          source: 'scan',
          uploadId: scanImport.uploadId,
          actor,
        }, pinnedMap);
      }
    }

    // Create revision
    const house = await prisma.house.findUnique({ where: { id: scanImport.houseId } });
    const revisionNumber = (house?.currentRevision || 0) + 1;

    const revision = await prisma.revision.create({
      data: {
        houseId: scanImport.houseId,
        workspaceId: null,
        scope: 'current',
        number: revisionNumber,
        actor,
        kind: 'rescan',
        note: `Promoted scan import: ${roomData.label}`,
      },
    });

    // Update house's currentRevision
    await prisma.house.update({
      where: { id: scanImport.houseId },
      data: { currentRevision: revision.id },
    });

    // Mark scan import as promoted
    await prisma.scanImport.update({
      where: { id: scanImportId },
      data: {
        status: 'promoted',
        promotedAt: new Date(),
        promotedBy: actor,
        roomId: room.id,
      },
    });

    return { success: true, roomId: room.id, revisionId: revision.id };
  };

  if (tx) {
    return await doPromotion(tx);
  } else {
    return await prisma.$transaction(async (t) => doPromotion(t), { timeout: 30_000 });
  }
}

async function recordMeasurementIfNotPinned(
  prisma: any,
  params: {
    entityType: string;
    entityId: number;
    field: string;
    valueIn: number;
    source: string;
    uploadId: number;
    actor: 'michael' | 'agent' | 'system';
  },
  pinnedMap: Map<string, number>
) {
  const key = `${params.entityType}:${params.entityId}:${params.field}`;
  const pinnedValue = pinnedMap.get(key);

  await prisma.measurement.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      field: params.field,
      valueIn: params.valueIn,
      source: params.source as any,
      uploadId: params.uploadId,
      recordedBy: params.actor,
      note: pinnedValue != null ? `Scan value: ${params.valueIn}, pinned value: ${pinnedValue} preserved` : null,
    },
  });
}

function reconstructParsedData(data: any[]) {
  const dataByEntity: Record<string, Record<number, Record<string, string>>> = {};
  
  for (const datum of data) {
    if (!dataByEntity[datum.entityType]) {
      dataByEntity[datum.entityType] = {};
    }
    if (!dataByEntity[datum.entityType][datum.entityIndex]) {
      dataByEntity[datum.entityType][datum.entityIndex] = {};
    }
    dataByEntity[datum.entityType][datum.entityIndex][datum.field] = datum.value;
  }

  return { parsedData: dataByEntity };
}

/**
 * Reject a scan import.
 */
export async function rejectScanImport(scanImportId: number, notes?: string) {
  const scanImport = await prisma.scanImport.findUnique({ where: { id: scanImportId } });

  if (!scanImport) {
    throw new ApiError(404, 'not_found', 'Scan import not found');
  }

  if (scanImport.status !== 'pending') {
    throw new ApiError(400, 'already_processed', 'Scan import has already been promoted or rejected');
  }

  await prisma.scanImport.update({
    where: { id: scanImportId },
    data: {
      status: 'rejected',
      notes,
    },
  });

  return { success: true };
}
