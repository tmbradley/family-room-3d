import { prisma } from './db.js';
import { effective } from './util.js';

async function measurementMap() {
  const all = await prisma.measurement.findMany();
  const groups = new Map<string, typeof all>();
  for (const m of all) {
    const k = `${m.entityType}:${m.entityId}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return (type: string, id: number) => effective((groups.get(`${type}:${id}`) ?? []) as any);
}

const roomInclude = (workspaceId: number | null) => ({
  walls: { include: { openings: true }, orderBy: { id: 'asc' as const } },
  fixtures: true,
  placements: { where: { workspaceId }, include: { item: true } },
});

export const NO_CURRENT_MESSAGE = 'No Current yet. Create one from a scan or confirmed measurements.';

/**
 * The house in inches, with measurement sources per field.
 * `current` is null until a Current is created (from a real scan or confirmed measurements).
 * Workspaces list their own draft rooms (rooms that are not part of Current) with full detail.
 */
export async function getHouse(houseId?: number) {
  const house = await prisma.house.findFirst({ where: houseId ? { id: houseId } : undefined, orderBy: { id: 'asc' } });
  if (!house) return null;
  const sources = await measurementMap();
  const roomView = (r: any) => ({
    id: r.id,
    slug: r.slug,
    label: r.label,
    draftWorkspaceId: r.draftWorkspaceId,
    originXIn: r.originXIn,
    originYIn: r.originYIn,
    rotationDeg: r.rotationDeg,
    ceilingIn: r.ceilingIn,
    floor: { material: r.floorMaterial, finish: r.floorFinish, color: r.floorColor, keep: r.floorKeep },
    wallColor: { name: r.wallColorName, color: r.wallColor },
    trimColor: { name: r.trimColorName, color: r.trimColor },
    measurementStatus: r.measurementStatus,
    measurements: sources('room', r.id),
    walls: r.walls.map(({ openings, ...w }: any) => ({
      ...w,
      measurements: sources('wall', w.id),
      openings: openings.map((o: any) => ({ ...o, measurements: sources('opening', o.id) })),
    })),
    fixtures: r.fixtures.map((f: any) => ({ ...f, measurements: sources('fixture', f.id) })),
    furniture: r.placements.map(({ item, ...p }: any) => ({
      ...p,
      measurements: sources('placement', p.id),
      item: { ...item, measurements: sources('furniture_item', item.id) },
    })),
  });

  const hasCurrent = house.currentRevision != null;
  const currentRooms = hasCurrent
    ? await prisma.room.findMany({ where: { houseId: house.id, draftWorkspaceId: null }, include: roomInclude(null), orderBy: { id: 'asc' } })
    : [];
  const workspaces = await prisma.workspace.findMany({ where: { houseId: house.id }, orderBy: { id: 'asc' } });
  const workspaceViews = await Promise.all(
    workspaces.map(async (w) => {
      const draftRooms = await prisma.room.findMany({ where: { draftWorkspaceId: w.id }, include: roomInclude(w.id), orderBy: { id: 'asc' } });
      return {
        id: w.id,
        name: w.name,
        notes: w.notes,
        revision: w.revision,
        baseRevision: w.baseRevision,
        basedOnCurrent: w.baseRevision != null,
        editable: true,
        rooms: draftRooms.map(roomView),
      };
    }),
  );
  const openProposals = await prisma.proposal.count({ where: { houseId: house.id, status: 'proposed' } });
  return {
    id: house.id,
    name: house.name,
    units: 'in',
    hasCurrent,
    currentRevision: house.currentRevision,
    current: hasCurrent ? { revision: house.currentRevision, locked: true, rooms: currentRooms.map(roomView) } : null,
    emptyState: hasCurrent ? null : NO_CURRENT_MESSAGE,
    openProposals,
    workspaces: workspaceViews,
  };
}

/** Whole-house export (Current if any + workspaces + proposals), lossless, in inches. */
export async function exportHouse() {
  const house = await getHouse();
  const [workspaces, items, proposals, measurements, revisions] = await Promise.all([
    prisma.workspace.findMany({ include: { rooms: true, styles: true, structureOverrides: true, placements: true } }),
    prisma.furnitureItem.findMany(),
    prisma.proposal.findMany({ include: { rooms: true, changes: true, comments: true } }),
    prisma.measurement.findMany(),
    prisma.revision.count(),
  ]);
  return {
    format: 'house-planner-export',
    version: 2,
    exportedAt: new Date().toISOString(),
    units: 'in',
    house,
    workspaces,
    furnitureItems: items,
    proposals,
    measurements,
    revisionCount: revisions,
  };
}
