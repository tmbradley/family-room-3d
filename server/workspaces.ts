import { ApiError, effective } from './util.js';
import { commitRevision, type RevChange } from './changes.js';
import type { Tx } from './entities.js';

async function measurementLookup(tx: Tx) {
  const all = await tx.measurement.findMany();
  const groups = new Map<string, typeof all>();
  for (const m of all) {
    const k = `${m.entityType}:${m.entityId}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return (type: string, id: number) => effective((groups.get(`${type}:${id}`) ?? []) as any);
}

const roomInclude = (workspaceId: number | null) => ({
  walls: { include: { openings: { orderBy: { id: 'asc' as const } } }, orderBy: { id: 'asc' as const } },
  fixtures: { orderBy: { id: 'asc' as const } },
  placements: { where: { workspaceId }, include: { item: true }, orderBy: { id: 'asc' as const } },
});

export async function roomViews(tx: Tx, where: any, workspaceId: number | null) {
  const sources = await measurementLookup(tx);
  const rooms = await tx.room.findMany({ where, include: roomInclude(workspaceId), orderBy: { id: 'asc' } });
  return rooms.map((r) => ({
    id: r.id, slug: r.slug, label: r.label, draftWorkspaceId: r.draftWorkspaceId,
    originXIn: r.originXIn, originYIn: r.originYIn, rotationDeg: r.rotationDeg, ceilingIn: r.ceilingIn,
    floor: { material: r.floorMaterial, finish: r.floorFinish, color: r.floorColor, keep: r.floorKeep },
    wallColor: { name: r.wallColorName, color: r.wallColor },
    trimColor: { name: r.trimColorName, color: r.trimColor },
    measurementStatus: r.measurementStatus,
    measurements: sources('room', r.id),
    walls: r.walls.map(({ openings, ...w }) => ({
      ...w, measurements: sources('wall', w.id),
      openings: openings.map((o) => ({ ...o, measurements: sources('opening', o.id) })),
    })),
    fixtures: r.fixtures.map((f) => ({ ...f, measurements: sources('fixture', f.id) })),
    furniture: r.placements.map(({ item, ...p }) => ({
      ...p, measurements: sources('placement', p.id),
      item: { ...item, measurements: sources('furniture_item', item.id) },
    })),
  }));
}

export async function listWorkspaces(tx: Tx) {
  const ws = await tx.workspace.findMany({
    orderBy: { id: 'asc' },
    include: { _count: { select: { draftRooms: true, rooms: true, placements: true } } },
  });
  const pending = await tx.proposal.groupBy({ by: ['targetWorkspaceId'], where: { status: 'pending' }, _count: true });
  return ws.map((w) => ({
    id: w.id, name: w.name, notes: w.notes, revision: w.revision, baseRevision: w.baseRevision,
    basedOnCurrent: w.baseRevision != null, createdBy: w.createdBy, createdAt: w.createdAt,
    rooms: w._count.rooms, placements: w._count.placements,
    pendingProposals: pending.find((p) => p.targetWorkspaceId === w.id)?._count ?? 0,
  }));
}

export async function getWorkspaceView(tx: Tx, workspaceId: number) {
  const w = await tx.workspace.findUnique({ where: { id: workspaceId }, include: { rooms: true } });
  if (!w) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  const roomIds = w.rooms.map((r) => r.roomId);
  const rooms = await roomViews(tx, { OR: [{ draftWorkspaceId: w.id }, { id: { in: roomIds } }] }, w.id);
  return {
    id: w.id, name: w.name, notes: w.notes, revision: w.revision, baseRevision: w.baseRevision,
    basedOnCurrent: w.baseRevision != null, editable: true, units: 'in', rooms,
  };
}

export async function getRoomView(tx: Tx, roomId: number, workspaceId?: number) {
  const room = await tx.room.findUnique({ where: { id: roomId } });
  if (!room) throw new ApiError(404, 'room_not_found', `Room ${roomId} not found`);
  const ws = workspaceId ?? room.draftWorkspaceId;
  if (ws == null) throw new ApiError(400, 'workspace_required', 'This is a Current room; pass workspaceId to see a design');
  if (room.draftWorkspaceId != null && room.draftWorkspaceId !== ws) throw new ApiError(400, 'not_in_workspace', `Room ${roomId} belongs to workspace ${room.draftWorkspaceId}`);
  const [view] = await roomViews(tx, { id: roomId }, ws);
  return { workspaceId: ws, ...view };
}

/**
 * Deep-copy a workspace: its draft rooms (walls, openings, fixtures, measurements), linked Current
 * rooms, color styles, structure overrides and placements. Returns the new workspace and an id map
 * ("type:oldId" -> newId) so proposal changes against the source can be re-targeted.
 */
export async function copyWorkspace(tx: Tx, sourceId: number, name: string, createdBy: 'michael' | 'agent' | 'system' = 'michael', sourceProposalId?: number) {
  const src = await tx.workspace.findUnique({
    where: { id: sourceId },
    include: { rooms: true, styles: true, structureOverrides: true, placements: { orderBy: { id: 'asc' } } },
  });
  if (!src) throw new ApiError(404, 'workspace_not_found', `Workspace ${sourceId} not found`);
  const ws = await tx.workspace.create({
    data: { houseId: src.houseId, name, notes: src.notes, baseRevision: src.baseRevision, revision: 0, createdBy, sourceProposalId },
  });
  const idMap = new Map<string, number>();
  const ms = await tx.measurement.findMany();
  const copyMeasurements = async (type: string, oldId: number, newId: number) => {
    const rows = ms.filter((m) => m.entityType === type && m.entityId === oldId);
    if (rows.length) await tx.measurement.createMany({ data: rows.map(({ id, entityId, ...m }) => ({ ...m, entityId: newId })) });
  };
  const drafts = await tx.room.findMany({ where: { draftWorkspaceId: sourceId }, include: { walls: { include: { openings: true } }, fixtures: true }, orderBy: { id: 'asc' } });
  for (const r of drafts) {
    const { id, walls, fixtures, draftWorkspaceId, ...room } = r;
    const nr = await tx.room.create({ data: { ...room, draftWorkspaceId: ws.id } });
    idMap.set(`room:${id}`, nr.id);
    await copyMeasurements('room', id, nr.id);
    for (const w of walls) {
      const { id: wid, openings, roomId, ...wall } = w;
      const nw = await tx.wall.create({ data: { ...wall, roomId: nr.id } });
      idMap.set(`wall:${wid}`, nw.id);
      await copyMeasurements('wall', wid, nw.id);
      for (const o of openings) {
        const { id: oid, wallId, ...op } = o;
        const no = await tx.opening.create({ data: { ...op, wallId: nw.id } });
        idMap.set(`opening:${oid}`, no.id);
        await copyMeasurements('opening', oid, no.id);
      }
    }
    for (const f of fixtures) {
      const { id: fid, roomId, wallId, ...fx } = f;
      const nf = await tx.fixture.create({ data: { ...fx, roomId: nr.id, wallId: wallId != null ? idMap.get(`wall:${wallId}`) ?? null : null } });
      idMap.set(`fixture:${fid}`, nf.id);
      await copyMeasurements('fixture', fid, nf.id);
    }
  }
  const room = (id: number) => idMap.get(`room:${id}`) ?? id;
  const links = new Set([...src.rooms.map((r) => r.roomId), ...drafts.map((r) => r.id)].map(room));
  if (links.size) await tx.workspaceRoom.createMany({ data: [...links].map((roomId) => ({ workspaceId: ws.id, roomId })) });
  if (src.styles.length) await tx.workspaceRoomStyle.createMany({ data: src.styles.map(({ workspaceId, roomId, ...s }) => ({ ...s, workspaceId: ws.id, roomId: room(roomId) })) });
  if (src.structureOverrides.length)
    await tx.structureOverride.createMany({ data: src.structureOverrides.map(({ id, workspaceId, ...s }) => ({ ...s, workspaceId: ws.id })) });
  for (const p of src.placements) {
    const { id, workspaceId, roomId, replacesPlacementId, ...pl } = p;
    const np = await tx.placement.create({
      data: { ...pl, workspaceId: ws.id, roomId: room(roomId), replacesPlacementId: replacesPlacementId != null ? idMap.get(`placement:${replacesPlacementId}`) ?? replacesPlacementId : null },
    });
    idMap.set(`placement:${id}`, np.id);
    await copyMeasurements('placement', id, np.id);
  }
  const changes: RevChange[] = [{ op: 'create', entityType: 'workspace', entityId: ws.id }];
  await commitRevision(tx, {
    workspaceId: ws.id, kind: 'copy', actor: createdBy, changes,
    note: `Copied from "${src.name}" (workspace ${src.id}) at revision ${src.revision}`,
  });
  return { workspace: await tx.workspace.findUniqueOrThrow({ where: { id: ws.id } }), idMap };
}

export async function createBlankWorkspace(tx: Tx, name: string) {
  const house = await tx.house.findFirst({ orderBy: { id: 'asc' } });
  if (!house) throw new ApiError(404, 'not_seeded', 'No house yet');
  return tx.workspace.create({ data: { houseId: house.id, name, revision: 0, createdBy: 'michael', baseRevision: house.currentRevision } });
}
