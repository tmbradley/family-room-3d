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
async function sync(tx: Tx, p: { workspaceId: number | null; houseId: number; entityType: string; entityId: number; field: string; actor: Actor; kind: 'save' | 'rescan'; note: string }) {
  const rows = await tx.measurement.findMany({ where: { entityType: p.entityType, entityId: p.entityId, field: p.field } });
  const eff = effective(rows as any)[p.field];
  const row = await delegate(tx, p.entityType).findUnique({ where: { id: p.entityId } });
  let revision: number | null = null;
  if (eff && row[p.field] !== eff.valueIn) {
    const { changes } = await applyOps(tx, [{ op: 'update', entityType: p.entityType, entityId: p.entityId, field: p.field, after: eff.valueIn }], {
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
    await tx.measurement.updateMany({ where: { entityType: m.entityType, entityId: m.entityId, field: m.field, source: 'manual', isOverride: true, unpinnedAt: null }, data: { unpinnedAt: new Date() } });
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
    where: { entityType: p.entityType, entityId: p.entityId, field: p.field, source: 'manual', isOverride: true, unpinnedAt: null },
    data: { unpinnedAt: new Date() },
  });
  if (!r.count) throw new ApiError(404, 'not_pinned', 'That value isn\'t pinned');
  const s = await sync(tx, { ...p, houseId, actor: 'michael', kind: 'save', note: `Unpinned ${p.entityType} ${p.entityId} ${p.field}` });
  return { unpinned: r.count, effective: s.effective, revision: s.revision };
}

export async function measurementHistory(tx: Tx, entityType: string, entityId: number) {
  return tx.measurement.findMany({ where: { entityType, entityId }, orderBy: [{ field: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }] });
}
