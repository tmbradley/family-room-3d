import { prisma } from './db.js';
import { roomViews, listWorkspaces } from './workspaces.js';

export const NO_CURRENT_MESSAGE = 'No Current yet. Create one from a scan or confirmed measurements.';

/**
 * The house in inches. `current` is null until a Current is created (from a real scan or
 * confirmed measurements). Workspaces are listed; GET /api/workspaces/:id has the full design.
 */
export async function getHouse(houseId?: number) {
  const house = await prisma.house.findFirst({ where: houseId ? { id: houseId } : undefined, orderBy: { id: 'asc' } });
  if (!house) return null;
  const hasCurrent = house.currentRevision != null;
  const workspaces = await listWorkspaces(prisma);
  const full = await Promise.all(
    workspaces.map(async (w) => ({ ...w, rooms: await roomViews(prisma, { draftWorkspaceId: w.id }, w.id) })),
  );
  const openProposals = await prisma.proposal.count({ where: { houseId: house.id, status: 'pending' } });
  return {
    id: house.id, name: house.name, units: 'in', hasCurrent,
    currentRevision: house.currentRevision,
    current: hasCurrent ? { revision: house.currentRevision, locked: true, rooms: await roomViews(prisma, { houseId: house.id, draftWorkspaceId: null }, null) } : null,
    emptyState: hasCurrent ? null : NO_CURRENT_MESSAGE,
    openProposals,
    workspaces: full,
  };
}

/** Whole-house export (Current if any + workspaces + proposals), lossless, in inches. */
export async function exportHouse() {
  const house = await getHouse();
  const [workspaces, items, proposals, measurements, revisions] = await Promise.all([
    prisma.workspace.findMany({ include: { rooms: true, styles: true, roomStyles: true, wallStyles: true, fixtures: true, structureOverrides: true, placements: { include: { params: true } } } }),
    prisma.furnitureItem.findMany(),
    prisma.proposal.findMany({ include: { rooms: true, changes: true, comments: true, costSteps: true } }),
    prisma.measurement.findMany(),
    prisma.revision.count(),
  ]);
  return {
    format: 'house-planner-export', version: 3, exportedAt: new Date().toISOString(), units: 'in',
    house, workspaces, furnitureItems: items, proposals, measurements, revisionCount: revisions,
  };
}
