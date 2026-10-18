/**
 * Measurement provenance. Every recorded value is kept. A pin (source = manual, isOverride) wins
 * over everything, so later scans and estimates are recorded for history but never change the
 * value the design uses until Michael unpins.
 */
import type { Actor, MeasurementSource } from '@prisma/client';
import { ApiError, effective } from './util.js';
import { def, delegate, ownerOf, type Tx } from './entities.js';
import { applyOps, commitRevision, lockHouse, lockWorkspace } from './changes.js';

type Input = {
  /** Workspace that owns the entity, or null for a Current entity. */
  workspaceId: number | null; entityType: string; entityId: number; field: string; valueIn: number;
  source: MeasurementSource; actor: Actor; note?: string; uploadId?: number;
};

/** Lock the scope being measured. Returns the house id (needed for Current revisions). */
async function lockScope(tx: Tx, workspaceId: number | null) {
  if (workspaceId !== null) return (await lockWorkspace(tx, workspaceId)).houseId;
  const house = await tx.house.findFirst({ orderBy: { id: 'asc' } });
  if (!house) throw new ApiError(404, 'house_not_found', 'No house');
  return (await lockHouse(tx, house.id)).id;
}

async function target(tx: Tx, workspaceId: number | null, entityType: string, entityId: number, field: string) {
  const d = def(entityType);
  if (!d.pinnable.includes(field))
    throw new ApiError(400, 'not_measurable', `${entityType}.${field} isn't a measurement. Measurable: ${d.pinnable.join(', ') || 'none'}`);
  const row = await delegate(tx, entityType).findUnique({ where: { id: entityId } });
  if (!row) throw new ApiError(404, 'entity_not_found', `${entityType} ${entityId} not found`);
  const owner = await ownerOf(tx, entityType, row);
  if (owner !== 'global' && owner !== workspaceId)
    throw new ApiError(403, 'not_in_workspace', `${entityType} ${entityId} isn't in ${workspaceId === null ? 'Current' : `workspace ${workspaceId}`}`);
  return row;
}

/** Make the stored column match the effective measurement; records a revision if it changes. */
async function sync(tx: Tx, p: { workspaceId: number | null; houseId: number; entityType: string; entityId: number; field: string; actor: Actor; kind: 'save' | 'rescan'; note: string; fallbackIn?: number }) {
  const rows = await tx.measurement.findMany({ where: { entityType: p.entityType, entityId: p.entityId, field: p.field } });
  const eff = effective(rows as any)[p.field];
  const row = await delegate(tx, p.entityType).findUnique({ where: { id: p.entityId } });
  let revision: number | null = null;
  // No measurement left (all withdrawn): go back to the value the editor had before.
  const want = eff?.valueIn ?? p.fallbackIn;
  if (want != null && row[p.field] !== want) {
    const { changes } = await applyOps(tx, [{ op: 'update', entityType: p.entityType, entityId: p.entityId, field: p.field, after: want }], {
      workspaceId: p.workspaceId, mode: 'measurement', allowPinned: true,
    });
    if (changes.length) revision = (await commitRevision(tx, { workspaceId: p.workspaceId, houseId: p.houseId, kind: p.kind, actor: p.actor, note: p.note, changes })).number;
  }
  return { effective: eff, revision };
}

export async function recordMeasurement(tx: Tx, m: Input) {
  const houseId = await lockScope(tx, m.workspaceId);
  await target(tx, m.workspaceId, m.entityType, m.entityId, m.field);
  if (!Number.isInteger(m.valueIn) || m.valueIn < 0 || m.valueIn > 100000) throw new ApiError(400, 'invalid_value', 'valueIn must be whole inches');
  if (m.source === 'manual') {
    // Re-pinning replaces any older pin on the field.
    await tx.measurement.updateMany({ where: { entityType: m.entityType, entityId: m.entityId, field: m.field, source: 'manual', isOverride: true, unpinnedAt: null, withdrawnAt: null }, data: { unpinnedAt: new Date() } });
  }
  const row = await tx.measurement.create({
    data: {
      entityType: m.entityType, entityId: m.entityId, field: m.field, valueIn: m.valueIn, source: m.source,
      isOverride: m.source === 'manual', recordedBy: m.actor, note: m.note?.slice(0, 500), uploadId: m.uploadId,
    },
  });
  const label = m.source === 'manual' ? 'Pinned' : m.source === 'measured' ? 'Measured' : m.source === 'scan' ? 'Scan' : 'Estimate';
  const s = await sync(tx, {
    workspaceId: m.workspaceId, houseId, entityType: m.entityType, entityId: m.entityId, field: m.field, actor: m.actor,
    kind: m.source === 'scan' ? 'rescan' : 'save', note: `${label} ${m.entityType} ${m.entityId} ${m.field} = ${m.valueIn}"`,
  });
  const applied = s.effective?.valueIn === m.valueIn && s.effective?.source === m.source;
  return { measurementId: row.id, applied, pinned: !!s.effective?.pinned, effective: s.effective, revision: s.revision };
}

export async function unpin(tx: Tx, p: { workspaceId: number | null; entityType: string; entityId: number; field: string }) {
  const houseId = await lockScope(tx, p.workspaceId);
  await target(tx, p.workspaceId, p.entityType, p.entityId, p.field);
  const r = await tx.measurement.updateMany({
    where: { entityType: p.entityType, entityId: p.entityId, field: p.field, source: 'manual', isOverride: true, unpinnedAt: null, withdrawnAt: null },
    data: { unpinnedAt: new Date() },
  });
  if (!r.count) throw new ApiError(404, 'not_pinned', 'That value isn\'t pinned');
  const s = await sync(tx, { ...p, houseId, actor: 'michael', kind: 'save', note: `Unpinned ${p.entityType} ${p.entityId} ${p.field}` });
  return { unpinned: r.count, effective: s.effective, revision: s.revision };
}

/** Scope (workspace id or null for Current) that owns a measured entity. */
async function scopeOf(tx: Tx, entityType: string, entityId: number, workspaceId: number | null) {
  const row = await delegate(tx, entityType).findUnique({ where: { id: entityId } });
  if (!row) throw new ApiError(404, 'entity_not_found', `${entityType} ${entityId} not found`);
  const owner = await ownerOf(tx, entityType, row);
  return owner === 'global' ? workspaceId : owner; // catalog items: the revision goes to the scope being edited
}

/**
 * Undo a measurement from the editor: the row stays (append-only record) but is marked withdrawn,
 * and the field goes back to the newest remaining measurement, or to `restoreIn` (the value shown
 * before) when none is left. `restore` re-activates it (redo).
 */
export async function setWithdrawn(tx: Tx, p: { measurementId: number; withdrawn: boolean; restoreIn?: number; workspaceId?: number | null }) {
  const m = await tx.measurement.findUnique({ where: { id: p.measurementId } });
  if (!m) throw new ApiError(404, 'measurement_not_found', `Measurement ${p.measurementId} not found`);
  const workspaceId = await scopeOf(tx, m.entityType, m.entityId, p.workspaceId ?? null);
  if (p.workspaceId != null && workspaceId !== p.workspaceId) throw new ApiError(403, 'not_in_workspace', `${m.entityType} ${m.entityId} isn't in workspace ${p.workspaceId}`);
  const houseId = await lockScope(tx, workspaceId);
  if (!!m.withdrawnAt === p.withdrawn) throw new ApiError(409, p.withdrawn ? 'already_withdrawn' : 'not_withdrawn', `Measurement ${m.id} is ${m.withdrawnAt ? 'already undone' : 'in effect'}`);
  if (!p.withdrawn && m.isOverride && m.source === 'manual' && !m.unpinnedAt) {
    // Redo of a pin: it replaces whatever pin is active now, like pinning does.
    await tx.measurement.updateMany({ where: { entityType: m.entityType, entityId: m.entityId, field: m.field, source: 'manual', isOverride: true, unpinnedAt: null, withdrawnAt: null }, data: { unpinnedAt: new Date() } });
  }
  await tx.measurement.update({ where: { id: m.id }, data: { withdrawnAt: p.withdrawn ? new Date() : null } });
  const s = await sync(tx, {
    workspaceId, houseId, entityType: m.entityType, entityId: m.entityId, field: m.field, actor: 'michael', kind: 'save',
    note: `${p.withdrawn ? 'Undid' : 'Redid'} measurement ${m.entityType} ${m.entityId} ${m.field} = ${m.valueIn}"`, fallbackIn: p.withdrawn ? p.restoreIn : undefined,
  });
  return { measurementId: m.id, withdrawn: p.withdrawn, effective: s.effective ?? null, revision: s.revision };
}

export async function measurementHistory(tx: Tx, entityType: string, entityId: number) {
  return tx.measurement.findMany({ where: { entityType, entityId }, orderBy: [{ field: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }] });
}
