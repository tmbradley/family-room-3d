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

/** Current state of the house, in inches, with measurement sources per field. */
export async function getHouse(houseId?: number) {
  const house = await prisma.house.findFirst({
    where: houseId ? { id: houseId } : undefined,
    orderBy: { id: 'asc' },
    include: {
      rooms: {
        include: {
          walls: { include: { openings: true }, orderBy: { id: 'asc' } },
          fixtures: true,
          placements: { where: { workspaceId: null }, include: { item: true } },
        },
        orderBy: { id: 'asc' },
      },
      workspaces: { select: { id: true, name: true, revision: true } },
    },
  });
  if (!house) return null;
  const sources = await measurementMap();
  const openProposals = await prisma.proposal.count({ where: { houseId: house.id, status: 'proposed' } });
  return {
    id: house.id,
    name: house.name,
    units: 'in',
    currentRevision: house.currentRevision,
    openProposals,
    workspaces: house.workspaces,
    rooms: house.rooms.map((r) => ({
      id: r.id,
      slug: r.slug,
      label: r.label,
      originXIn: r.originXIn,
      originYIn: r.originYIn,
      rotationDeg: r.rotationDeg,
      ceilingIn: r.ceilingIn,
      floor: { material: r.floorMaterial, finish: r.floorFinish, color: r.floorColor, keep: r.floorKeep },
      wallColor: { name: r.wallColorName, color: r.wallColor },
      trimColor: { name: r.trimColorName, color: r.trimColor },
      measurementStatus: r.measurementStatus,
      measurements: sources('room', r.id),
      walls: r.walls.map(({ openings, ...w }) => ({
        ...w,
        measurements: sources('wall', w.id),
        openings: openings.map((o) => ({ ...o, measurements: sources('opening', o.id) })),
      })),
      fixtures: r.fixtures.map((f) => ({ ...f, measurements: sources('fixture', f.id) })),
      furniture: r.placements.map(({ item, ...p }) => ({
        ...p,
        measurements: sources('placement', p.id),
        item: { ...item, measurements: sources('furniture_item', item.id) },
      })),
    })),
  };
}

/** Whole-house export (Current + workspaces + proposals), lossless, in inches. */
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
    version: 1,
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
