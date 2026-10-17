import { prisma } from './db.js';
import { ApiError } from './util.js';
import type { Prisma } from '@prisma/client';
import { saveChanges, saveChangesForRescan, type Op } from './changes.js';

/**
 * Apple RoomPlan CapturedRoom structure (real format from JSONEncoder)
 */
export interface CapturedRoom {
  dimensions: number[]; // [width, length, height] in meters (simd_float3)
  walls: Array<{
    identifier: string;
    category: string;
    dimensions: number[]; // [width, length, height]
    transform: number[]; // 4x4 column-major matrix
    confidence: string;
  }>;
  doors: Array<{
    identifier: string;
    parentIdentifier: string;
    category: string;
    dimensions: number[]; // [width, height]
    transform: number[];
    confidence: string;
  }>;
  windows: Array<{
    identifier: string;
    parentIdentifier: string;
    category: string;
    dimensions: number[]; // [width, height]
    transform: number[];
    confidence: string;
  }>;
  openings: Array<{
    identifier: string;
    parentIdentifier: string;
    category: string;
    dimensions: number[]; // [width, height]
    transform: number[];
    confidence: string;
  }>;
  objects: Array<{
    identifier: string;
    category: string;
    dimensions: number[]; // [width, length, height]
    transform: number[];
    confidence: string;
  }>;
}

interface ParsedRoom {
  label: string;
  widthIn: number;
  depthIn: number;
  ceilingIn: number;
  walls: Array<{
    index: number;
    identifier: string;
    startXIn: number;
    startYIn: number;
    endXIn: number;
    endYIn: number;
    heightIn: number;
    thicknessIn: number;
  }>;
  openings: Array<{
    index: number;
    identifier: string;
    wallIdentifier: string;
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

function metersToInches(meters: number): number {
  return Math.round(meters * 39.3701);
}

function extractPosition(transform: number[]): { x: number; y: number; z: number } {
  return {
    x: transform[12],
    y: transform[13],
    z: transform[14],
  };
}

function extractRotationYaw(transform: number[]): number {
  const m00 = transform[0];
  const m02 = transform[8];
  const yaw = Math.atan2(m02, m00);
  return Math.round((yaw * 180) / Math.PI);
}

function calculateWallEndpoints(transform: number[], widthMeters: number) {
  const pos = extractPosition(transform);
  
  const m00 = transform[0];
  const m01 = transform[4];
  const m02 = transform[8];
  
  const length = Math.sqrt(m00 * m00 + m01 * m01 + m02 * m02);
  const dirX = length > 0 ? m00 / length : 1;
  const dirZ = length > 0 ? m02 / length : 0;
  
  const halfWidth = widthMeters / 2;
  
  return {
    startXIn: metersToInches(pos.x - dirX * halfWidth),
    startYIn: metersToInches(pos.z - dirZ * halfWidth),
    endXIn: metersToInches(pos.x + dirX * halfWidth),
    endYIn: metersToInches(pos.z + dirZ * halfWidth),
  };
}

function calculateOffsetAlongWall(
  openingPos: { x: number; z: number },
  wallStart: { x: number; z: number },
  wallEnd: { x: number; z: number }
): number {
  const wallDx = wallEnd.x - wallStart.x;
  const wallDz = wallEnd.z - wallStart.z;
  const wallLength = Math.sqrt(wallDx * wallDx + wallDz * wallDz);
  
  if (wallLength === 0) return 0;
  
  const openingDx = openingPos.x - wallStart.x;
  const openingDz = openingPos.z - wallStart.z;
  
  const projection = (openingDx * wallDx + openingDz * wallDz) / (wallLength * wallLength);
  const offset = projection * wallLength;
  
  return metersToInches(Math.max(0, Math.min(wallLength, offset)));
}

export function parseCapturedRoom(data: CapturedRoom, label?: string): ParsedRoom {
  const widthIn = metersToInches(data.dimensions[0]);
  const depthIn = metersToInches(data.dimensions[1]);
  const ceilingIn = metersToInches(data.dimensions[2]);

  const walls = data.walls.map((wall, index) => {
    const widthMeters = wall.dimensions[0];
    const heightMeters = wall.dimensions[2];
    const endpoints = calculateWallEndpoints(wall.transform, widthMeters);
    
    return {
      index,
      identifier: wall.identifier,
      startXIn: endpoints.startXIn,
      startYIn: endpoints.startYIn,
      endXIn: endpoints.endXIn,
      endYIn: endpoints.endYIn,
      heightIn: metersToInches(heightMeters),
      thicknessIn: 5,
    };
  });

  const wallMap = new Map(walls.map(w => [w.identifier, w]));

  const allOpenings: Array<{
    identifier: string;
    parentIdentifier: string;
    type: 'window' | 'door' | 'open_span';
    dimensions: number[];
    transform: number[];
  }> = [
    ...data.doors.map(d => ({ ...d, type: 'door' as const })),
    ...data.windows.map(w => ({ ...w, type: 'window' as const })),
    ...data.openings.map(o => ({ ...o, type: 'open_span' as const })),
  ];

  const openings = allOpenings.map((opening, index) => {
    const pos = extractPosition(opening.transform);
    const parentWall = wallMap.get(opening.parentIdentifier);
    
    const widthIn = metersToInches(opening.dimensions[0]);
    const heightIn = metersToInches(opening.dimensions[1]);
    
    let offsetIn = 0;
    if (parentWall) {
      const wallStartMeters = { x: parentWall.startXIn / 39.3701, z: parentWall.startYIn / 39.3701 };
      const wallEndMeters = { x: parentWall.endXIn / 39.3701, z: parentWall.endYIn / 39.3701 };
      offsetIn = calculateOffsetAlongWall({ x: pos.x, z: pos.z }, wallStartMeters, wallEndMeters);
    }
    
    return {
      index,
      identifier: opening.identifier,
      wallIdentifier: opening.parentIdentifier,
      type: opening.type,
      offsetIn,
      widthIn,
      sillIn: opening.type === 'window' ? 36 : 0,
      headIn: opening.type === 'window' ? 36 + heightIn : heightIn,
    };
  });

  const objects = data.objects.map((obj, index) => {
    const pos = extractPosition(obj.transform);
    const rotation = extractRotationYaw(obj.transform);

    return {
      index,
      kind: obj.category.toLowerCase(),
      xIn: metersToInches(pos.x),
      yIn: metersToInches(pos.z),
      rotationDeg: rotation,
      widthIn: metersToInches(obj.dimensions[0]),
      depthIn: metersToInches(obj.dimensions[1]),
      heightIn: metersToInches(obj.dimensions[2]),
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

export async function createScanImport(params: {
  houseId: number;
  uploadId: number;
  roomplanData: CapturedRoom;
  label?: string;
  roomId?: number;
}) {
  const { houseId, uploadId, roomplanData, label, roomId } = params;

  const parsed = parseCapturedRoom(roomplanData, label);

  const scanImport = await prisma.scanImport.create({
    data: {
      houseId,
      roomId: roomId ?? null,
      uploadId,
      label: parsed.label,
      status: 'pending',
    },
  });

  const dataRecords: Prisma.ScanImportDataCreateManyInput[] = [];

  dataRecords.push(
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'label', value: parsed.label },
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'widthIn', value: String(parsed.widthIn) },
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'depthIn', value: String(parsed.depthIn) },
    { scanImportId: scanImport.id, entityType: 'room', entityIndex: 0, field: 'ceilingIn', value: String(parsed.ceilingIn) }
  );

  for (const wall of parsed.walls) {
    dataRecords.push(
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'identifier', value: wall.identifier },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'startXIn', value: String(wall.startXIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'startYIn', value: String(wall.startYIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'endXIn', value: String(wall.endXIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'endYIn', value: String(wall.endYIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'heightIn', value: String(wall.heightIn) },
      { scanImportId: scanImport.id, entityType: 'wall', entityIndex: wall.index, field: 'thicknessIn', value: String(wall.thicknessIn) }
    );
  }

  for (const opening of parsed.openings) {
    dataRecords.push(
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'identifier', value: opening.identifier },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'wallIdentifier', value: opening.wallIdentifier },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'type', value: opening.type },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'offsetIn', value: String(opening.offsetIn) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'widthIn', value: String(opening.widthIn) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'sillIn', value: String(opening.sillIn) },
      { scanImportId: scanImport.id, entityType: 'opening', entityIndex: opening.index, field: 'headIn', value: String(opening.headIn) }
    );
  }

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

  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: 'imported', scanImportId: scanImport.id },
  });

  return scanImport;
}

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

export async function promoteScanImport(
  scanImportId: number,
  actor: 'michael' | 'agent' = 'michael',
  tx?: any
) {
  const doPromotion = async (tx: any) => {
    const scanImport = await tx.scanImport.findUnique({
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

    const roomData = dataByEntity.room?.[0];
    if (!roomData) {
      throw new ApiError(400, 'invalid_data', 'No room data found in scan import');
    }

    const slug = roomData.label?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'scanned-room';
    
    const existingRoom = await tx.room.findFirst({
      where: {
        houseId: scanImport.houseId,
        slug,
        draftWorkspaceId: null,
      },
      include: {
        walls: { include: { openings: true } },
      },
    });

    const changes: Op[] = [];
    const measurements: Array<{
      entityType: string;
      entityId?: number;
      entityRef?: string;
      field: string;
      valueIn: number;
    }> = [];

    if (!existingRoom) {
      changes.push({
        op: 'create',
        entityType: 'room',
        tempRef: 'room-1',
        fields: {
          houseId: scanImport.houseId,
          slug,
          label: roomData.label,
          ceilingIn: Number(roomData.ceilingIn),
          measurementStatus: 'scan',
          floorMaterial: 'hardwood',
          floorColor: '#d4a574',
          floorKeep: true,
          draftWorkspaceId: null,
        },
      });
      measurements.push({
        entityType: 'room',
        entityRef: 'room-1',
        field: 'ceilingIn',
        valueIn: Number(roomData.ceilingIn),
      });
    } else {
      const ceilingPin = await tx.measurement.findFirst({
        where: {
          entityType: 'room',
          entityId: existingRoom.id,
          field: 'ceilingIn',
          source: 'manual',
          isOverride: true,
          unpinnedAt: null,
        },
      });

      measurements.push({
        entityType: 'room',
        entityId: existingRoom.id,
        field: 'ceilingIn',
        valueIn: Number(roomData.ceilingIn),
      });

      if (!ceilingPin) {
        changes.push({
          op: 'update',
          entityType: 'room',
          entityId: existingRoom.id,
          field: 'ceilingIn',
          after: Number(roomData.ceilingIn),
        });
      }

      changes.push({
        op: 'update',
        entityType: 'room',
        entityId: existingRoom.id,
        field: 'label',
        after: roomData.label,
      });

      for (const wall of existingRoom.walls) {
        changes.push({ op: 'delete', entityType: 'wall', entityId: wall.id });
      }
    }

    for (const [idxStr, wallData] of Object.entries(dataByEntity.wall || {})) {
      const wallRef = `wall-${idxStr}`;
      changes.push({
        op: 'create',
        entityType: 'wall',
        tempRef: wallRef,
        fields: {
          roomId: existingRoom ? existingRoom.id : `$room-1`,
          startXIn: Number(wallData.startXIn),
          startYIn: Number(wallData.startYIn),
          endXIn: Number(wallData.endXIn),
          endYIn: Number(wallData.endYIn),
          heightIn: Number(wallData.heightIn),
          thicknessIn: Number(wallData.thicknessIn || 5),
          measurementStatus: 'scan',
        },
      });

      measurements.push(
        { entityType: 'wall', entityRef: wallRef, field: 'startXIn', valueIn: Number(wallData.startXIn) },
        { entityType: 'wall', entityRef: wallRef, field: 'startYIn', valueIn: Number(wallData.startYIn) },
        { entityType: 'wall', entityRef: wallRef, field: 'endXIn', valueIn: Number(wallData.endXIn) },
        { entityType: 'wall', entityRef: wallRef, field: 'endYIn', valueIn: Number(wallData.endYIn) },
        { entityType: 'wall', entityRef: wallRef, field: 'heightIn', valueIn: Number(wallData.heightIn) },
        { entityType: 'wall', entityRef: wallRef, field: 'thicknessIn', valueIn: Number(wallData.thicknessIn || 5) }
      );
    }

    const wallRefs = new Map<string, string>();
    for (const [idxStr, wallData] of Object.entries(dataByEntity.wall || {})) {
      wallRefs.set(wallData.identifier, `wall-${idxStr}`);
    }

    for (const [idxStr, openingData] of Object.entries(dataByEntity.opening || {})) {
      const wallRef = wallRefs.get(openingData.wallIdentifier);
      if (wallRef) {
        const openingRef = `opening-${idxStr}`;
        changes.push({
          op: 'create',
          entityType: 'opening',
          tempRef: openingRef,
          fields: {
            wallId: `$${wallRef}`,
            type: openingData.type,
            offsetIn: Number(openingData.offsetIn),
            widthIn: Number(openingData.widthIn),
            sillIn: Number(openingData.sillIn),
            headIn: Number(openingData.headIn),
            measurementStatus: 'scan',
          },
        });

        measurements.push(
          { entityType: 'opening', entityRef: openingRef, field: 'offsetIn', valueIn: Number(openingData.offsetIn) },
          { entityType: 'opening', entityRef: openingRef, field: 'widthIn', valueIn: Number(openingData.widthIn) },
          { entityType: 'opening', entityRef: openingRef, field: 'sillIn', valueIn: Number(openingData.sillIn) },
          { entityType: 'opening', entityRef: openingRef, field: 'headIn', valueIn: Number(openingData.headIn) }
        );
      }
    }

    let revisionNumber = scanImport.house.currentRevision || 0;
    let roomId = existingRoom?.id;
    
    const result = await saveChangesForRescan(
      tx,
      null,
      revisionNumber,
      changes,
      `Promoted scan: ${roomData.label}`,
      { houseId: scanImport.houseId }
    );
    revisionNumber = typeof result.revision === 'number' ? result.revision : result.revision.number;
    
    if (!existingRoom) {
      roomId = result.refs['room-1'];
    }

    for (const meas of measurements) {
      let entityId = meas.entityId;
      if (!entityId && meas.entityRef) {
        entityId = result.refs[meas.entityRef];
      }

      if (entityId) {
        const existingPin = await tx.measurement.findFirst({
          where: {
            entityType: meas.entityType,
            entityId,
            field: meas.field,
            source: 'manual',
            isOverride: true,
            unpinnedAt: null,
          },
        });

        await tx.measurement.create({
          data: {
            entityType: meas.entityType,
            entityId,
            field: meas.field,
            valueIn: meas.valueIn,
            source: 'scan',
            isOverride: false,
            uploadId: scanImport.uploadId,
            recordedBy: 'system',
            note: existingPin ? `Scanned value (not applied - pinned to ${existingPin.valueIn})` : null,
          },
        });
      }
    }

    await tx.scanImport.update({
      where: { id: scanImportId },
      data: {
        status: 'promoted',
        promotedAt: new Date(),
        promotedBy: actor,
        roomId,
      },
    });

    await tx.house.update({
      where: { id: scanImport.houseId },
      data: { currentRevision: revisionNumber },
    });

    return { success: true, roomId, revisionId: revisionNumber };
  };

  if (tx) {
    return await doPromotion(tx);
  } else {
    return await prisma.$transaction(async (t) => doPromotion(t), { timeout: 30_000 });
  }
}

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
