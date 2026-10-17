/**
 * The one way design data changes: a list of field-level ops applied inside a transaction and
 * recorded as an append-only revision (revisions + revision_changes). Used by editor saves,
 * approved proposals, measurements, and rollbacks.
 */
import type { Actor, RevisionKind } from '@prisma/client';
import { ApiError } from './util.js';
import { coerce, def, delegate, fieldSpec, ownerOf, ser, workspaceRoomIds, type Tx } from './entities.js';

export type Op =
  | { op: 'create'; entityType: string; tempRef?: string; fields: Record<string, unknown>; id?: number }
  | { op: 'update'; entityType: string; entityId: number; field: string; after: unknown; before?: string | null }
  | { op: 'delete'; entityType: string; entityId: number };

export type RevChange = {
  op: 'create' | 'update' | 'delete'; entityType: string; entityId: number; field?: string | null;
  beforeValue?: string | null; afterValue?: string | null;
};

export type ApplyCtx = {
  workspaceId: number | null;
  mode: 'save' | 'proposal' | 'rollback' | 'measurement';
  /** For "new workspace" proposals: ids in the base workspace -> ids in the copy. */
  idMap?: Map<string, number>;
  /** Refuse to apply an update whose stored `before` no longer matches (proposals). */
  checkBefore?: boolean;
  /** Measurement pins write pinned fields; everything else must not. */
  allowPinned?: boolean;
};

export async function isPinned(tx: Tx, entityType: string, entityId: number, field: string) {
  const pin = await tx.measurement.findFirst({
    where: { entityType, entityId, field, source: 'manual', isOverride: true, unpinnedAt: null },
    select: { id: true },
  });
  return !!pin;
}

export async function lockWorkspace(tx: Tx, workspaceId: number | null) {
  if (workspaceId === null) return null;
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  return ws;
}

const mapId = (ctx: ApplyCtx, type: string, id: number) => {
  if (ctx.workspaceId === null) return id;
  return ctx.idMap?.get(`${type}:${id}`) ?? id;
};

export async function applyOps(tx: Tx, ops: Op[], ctx: ApplyCtx) {
  const changes: RevChange[] = [];
  const skipped: string[] = [];
  const refs: Record<string, number> = {};
  const W = ctx.workspaceId;
  const allowSystem = ctx.mode === 'rollback';
  let roomIds: Set<number> | null = null;
  const rooms = async () => {
    if (W === null || W === -1) return new Set<number>();
    return (roomIds ??= await workspaceRoomIds(tx, W));
  };

  const resolve = (type: string, field: string, raw: unknown) => {
    if (typeof raw === 'string' && raw.startsWith('$')) {
      const id = refs[raw.slice(1)];
      if (id == null) throw new ApiError(400, 'unknown_ref', `${type}.${field} refers to "${raw}", which isn't created earlier in this change list`);
      return id;
    }
    const v = coerce(type, field, raw, allowSystem);
    const spec = fieldSpec(type, field, true) as any;
    if (spec.ref && typeof v === 'number') return mapId(ctx, spec.ref, v);
    return v;
  };

  const checkOwner = async (type: string, row: any) => {
    if (W === null || W === -1) return;
    const owner = await ownerOf(tx, type, row);
    if (owner === 'global' || owner === W) return;
    throw new ApiError(403, 'not_in_workspace', `${type} ${row.id ?? ''} isn't part of workspace ${W}${owner === null ? ' (it belongs to Current)' : ''}`);
  };

  const checkRefs = async (type: string, data: Record<string, any>) => {
    if ('roomId' in data && data.roomId != null) {
      const room = await tx.room.findUnique({ where: { id: data.roomId } });
      if (!room) throw new ApiError(400, 'invalid_ref', `room ${data.roomId} not found`);
      if (type === 'placement' ? !(await rooms()).has(room.id) : room.draftWorkspaceId !== W)
        throw new ApiError(403, 'not_in_workspace', `room ${room.id} isn't ${type === 'placement' ? 'in' : 'a draft room of'} workspace ${W}`);
    }
    if (type === 'placement' && data.itemId != null && !(await tx.furnitureItem.findUnique({ where: { id: data.itemId } })))
      throw new ApiError(400, 'invalid_ref', `furniture_item ${data.itemId} not found`);
    if (type === 'placement' && data.replacesPlacementId != null && !(await tx.placement.findUnique({ where: { id: data.replacesPlacementId } })))
      throw new ApiError(400, 'invalid_ref', `placement ${data.replacesPlacementId} not found`);
    if ('wallId' in data && data.wallId != null) {
      const wall = await tx.wall.findUnique({ where: { id: data.wallId }, include: { room: true } });
      if (!wall || wall.room.draftWorkspaceId !== W) throw new ApiError(403, 'not_in_workspace', `wall ${data.wallId} isn't in workspace ${W}`);
    }
  };

  const snapshot = (type: string, row: any) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(def(type).fields)) out[k] = row[k];
    return out;
  };

  for (const op of ops) {
    const d = def(op.entityType);
    const model = delegate(tx, op.entityType);

    if (op.op === 'create') {
      if (!d.create) throw new ApiError(400, 'not_creatable', `${op.entityType} can't be created by a change`);
      const data: Record<string, any> = {};
      for (const [k, v] of Object.entries(op.fields ?? {})) {
        const spec = fieldSpec(op.entityType, k, true);
        if (spec && (spec as any).system && W === null && !allowSystem) {
          data[k] = v;
        } else {
          data[k] = resolve(op.entityType, k, v);
        }
      }
      if (!allowSystem) {
        const missing = d.required.filter((k) => data[k] === undefined);
        if (missing.length) throw new ApiError(400, 'missing_fields', `${op.entityType} create needs ${missing.join(', ')}`);
      }
      if (op.entityType === 'placement' && !allowSystem) data.workspaceId = W;
      await checkRefs(op.entityType, data);
      if (op.entityType === 'placement' && !allowSystem && W !== null && W > 0 && data.workspaceId !== W) throw new ApiError(403, 'not_in_workspace', 'placement must be in this workspace');
      if (op.id != null) data.id = op.id;
      const row = await model.create({ data });
      if (op.tempRef) refs[op.tempRef] = row.id;
      changes.push({ op: 'create', entityType: op.entityType, entityId: row.id });
      for (const [k, v] of Object.entries(snapshot(op.entityType, row)))
        if (v !== null && v !== undefined) changes.push({ op: 'create', entityType: op.entityType, entityId: row.id, field: k, afterValue: ser(v) });
      continue;
    }

    const id = mapId(ctx, op.entityType, op.entityId);
    const row = await model.findUnique({ where: { id } });
    if (!row) throw new ApiError(404, 'entity_not_found', `${op.entityType} ${id} not found`);
    await checkOwner(op.entityType, row);

    if (op.op === 'update') {
      fieldSpec(op.entityType, op.field, allowSystem);
      const val = resolve(op.entityType, op.field, op.after);
      if (d.pinnable.includes(op.field) && !ctx.allowPinned && (await isPinned(tx, op.entityType, id, op.field))) {
        if (ctx.mode === 'rollback') { skipped.push(`${op.entityType} ${id} ${op.field} (pinned)`); continue; }
        throw new ApiError(409, 'pinned', `${op.entityType} ${id} ${op.field} is a pinned measurement and can't be changed. Unpin it first.`);
      }
      if (ctx.checkBefore && op.before !== undefined && ser(row[op.field]) !== op.before)
        throw new ApiError(409, 'stale', `${op.entityType} ${id} ${op.field} changed since this was proposed (was ${op.before}, now ${ser(row[op.field])})`);
      if (ser(row[op.field]) === ser(val)) continue;
      if (op.field in { roomId: 1, wallId: 1, itemId: 1, replacesPlacementId: 1 }) await checkRefs(op.entityType, { ...row, [op.field]: val });
      await model.update({ where: { id }, data: { [op.field]: val } });
      changes.push({ op: 'update', entityType: op.entityType, entityId: id, field: op.field, beforeValue: ser(row[op.field]), afterValue: ser(val) });
      continue;
    }

    // delete
    if (!d.delete) {
      // Rolling back past the creation of a catalog item removes it again, unless something still uses it.
      if (ctx.mode === 'rollback' && op.entityType === 'furniture_item') {
        if (await tx.placement.count({ where: { itemId: id } })) { skipped.push(`furniture_item ${id} (still used)`); continue; }
      } else throw new ApiError(400, 'not_deletable', `${op.entityType} can't be deleted by a change`);
    }
    if (op.entityType === 'wall') {
      const [o, f] = await Promise.all([tx.opening.count({ where: { wallId: id } }), tx.fixture.count({ where: { wallId: id } })]);
      if (o || f) throw new ApiError(409, 'has_children', `wall ${id} still has openings or fixtures; delete those first`);
    }
    if (op.entityType === 'placement' && (await tx.placement.count({ where: { replacesPlacementId: id } })))
      throw new ApiError(409, 'has_children', `placement ${id} is replaced by another placement; change that one first`);
    await model.delete({ where: { id } });
    changes.push({ op: 'delete', entityType: op.entityType, entityId: id });
    for (const [k, v] of Object.entries(snapshot(op.entityType, row)))
      if (v !== null && v !== undefined) changes.push({ op: 'delete', entityType: op.entityType, entityId: id, field: k, beforeValue: ser(v) });
  }
  return { changes, skipped, refs };
}

export async function commitRevision(
  tx: Tx,
  p: { workspaceId: number | null; houseId?: number; kind: RevisionKind; actor: Actor; agentKeyId?: number | null; proposalId?: number | null; note?: string | null; rollsBackRevisionId?: number | null; changes: RevChange[]; baseRevision?: number },
) {
  let houseId: number;
  let number: number;
  let scope: string;

  if (p.workspaceId !== null) {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: p.workspaceId } });
    houseId = ws.houseId;
    number = ws.revision + 1;
    scope = `workspace:${ws.id}`;
  } else {
    if (!p.houseId) throw new ApiError(400, 'invalid_request', 'houseId required for Current revisions');
    houseId = p.houseId;
    number = (p.baseRevision ?? 0) + 1;
    scope = 'house';
  }

  const rev = await tx.revision.create({
    data: {
      houseId, workspaceId: p.workspaceId, scope, number, actor: p.actor, kind: p.kind,
      agentKeyId: p.agentKeyId ?? null, proposalId: p.proposalId ?? null, rollsBackRevisionId: p.rollsBackRevisionId ?? null,
      note: p.note?.slice(0, 1000) ?? null,
    },
  });
  if (p.changes.length) await tx.revisionChange.createMany({ data: p.changes.map((c, seq) => ({ ...c, seq, revisionId: rev.id, field: c.field ?? null })) });
  
  if (p.workspaceId !== null) {
    await tx.workspace.update({ where: { id: p.workspaceId }, data: { revision: number } });
  }
  
  return rev;
}

/** Michael's own edit from the editor: applied directly, recorded as a "save" revision. */
export async function saveChanges(
  tx: Tx,
  workspaceId: number | null,
  baseRevision: number,
  ops: Op[],
  note?: string,
  params?: { houseId?: number; isCurrent?: boolean }
) {
  const ws = await lockWorkspace(tx, workspaceId);
  
  if (workspaceId !== null && ws) {
    if (ws.revision !== baseRevision)
      throw new ApiError(409, 'conflict', `Workspace is at revision ${ws.revision}, your edit was based on ${baseRevision}. Reload to get the latest.`, { revision: ws.revision });
  }

  const effectiveWorkspaceId = workspaceId === null ? null : workspaceId;
  const { changes, refs } = await applyOps(tx, ops, { workspaceId: effectiveWorkspaceId, mode: 'save' });
  if (!changes.length && workspaceId && ws) return { revision: ws.revision, refs, unchanged: true };

  const rev = await commitRevision(tx, {
    workspaceId,
    houseId: params?.houseId ?? (ws?.houseId ?? undefined),
    kind: 'save',
    actor: params?.isCurrent ? 'system' : 'michael',
    note: note ?? 'Edit in the editor',
    changes,
    baseRevision,
  });

  return { revision: rev, refs, roomId: refs['room-1'], unchanged: false };
}

export async function saveChangesForRescan(
  tx: Tx,
  workspaceId: number | null,
  baseRevision: number,
  ops: Op[],
  note?: string,
  params?: { houseId?: number }
) {
  const effectiveWorkspaceId = workspaceId === null ? null : workspaceId;
  const { changes, refs } = await applyOps(tx, ops, { workspaceId: effectiveWorkspaceId, mode: 'save' });

  const rev = await commitRevision(tx, {
    workspaceId,
    houseId: params?.houseId,
    kind: 'rescan',
    actor: 'system',
    note: note ?? 'Scan promotion',
    changes,
    baseRevision,
  });

  return { revision: rev, refs, roomId: refs['room-1'], unchanged: false };
}

/** Inverse ops for one revision's change rows (newest first). */
export function inverseOps(rows: { seq: number; op: string; entityType: string; entityId: number; field: string | null; beforeValue: string | null }[]): Op[] {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const groups: Op[] = [];
  let i = 0;
  while (i < sorted.length) {
    const r = sorted[i];
    if (r.op === 'update' && r.field) {
      groups.push({ op: 'update', entityType: r.entityType, entityId: r.entityId, field: r.field, after: r.beforeValue });
      i++;
    } else if (r.op === 'create' && !r.field) {
      groups.push({ op: 'delete', entityType: r.entityType, entityId: r.entityId });
      i++;
      while (i < sorted.length && sorted[i].op === 'create' && sorted[i].field && sorted[i].entityType === r.entityType && sorted[i].entityId === r.entityId) i++;
    } else if (r.op === 'delete' && !r.field) {
      const fields: Record<string, unknown> = {};
      i++;
      while (i < sorted.length && sorted[i].op === 'delete' && sorted[i].field && sorted[i].entityType === r.entityType && sorted[i].entityId === r.entityId) {
        fields[sorted[i].field!] = sorted[i].beforeValue;
        i++;
      }
      groups.push({ op: 'create', entityType: r.entityType, id: r.entityId, fields });
    } else i++;
  }
  return groups.reverse();
}

/** Roll a workspace back to the state right after revision `toRevision`. The rollback is itself a new revision. */
export async function rollbackWorkspace(tx: Tx, workspaceId: number, toRevision: number, note?: string) {
  const ws = await lockWorkspace(tx, workspaceId);
  if (!ws) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  if (!Number.isInteger(toRevision) || toRevision < 0 || toRevision >= ws.revision)
    throw new ApiError(400, 'invalid_revision', `Pick a revision between 0 and ${ws.revision - 1}`);
  const later = await tx.revision.findMany({
    where: { workspaceId, number: { gt: toRevision } }, orderBy: { number: 'desc' }, include: { changes: true },
  });
  const base = later.find((r) => r.kind === 'seed' || r.kind === 'copy');
  if (base) throw new ApiError(409, 'before_start', `Can't roll back past revision ${base.number} (${base.kind}), where this workspace started`);
  const ops = later.flatMap((r) => inverseOps(r.changes));
  const { changes, skipped } = await applyOps(tx, ops, { workspaceId, mode: 'rollback' });
  const target = toRevision > 0 ? await tx.revision.findFirst({ where: { workspaceId, number: toRevision } }) : null;
  const rev = await commitRevision(tx, {
    workspaceId, kind: 'rollback', actor: 'michael', rollsBackRevisionId: target?.id ?? null, changes,
    note: [note || `Rolled back to revision ${toRevision}`, skipped.length ? `Kept pinned: ${skipped.join('; ')}` : ''].filter(Boolean).join('. '),
  });
  return { revision: rev.number, skipped };
}

export async function getHistory(tx: Tx, workspaceId: number, limit = 50) {
  const revs = await tx.revision.findMany({
    where: { workspaceId }, orderBy: { number: 'desc' }, take: Math.min(Math.max(limit, 1), 200),
    include: { changes: { orderBy: { seq: 'asc' } }, proposal: { select: { id: true, title: true } }, agentKey: { select: { name: true } } },
  });
  return revs.map((r) => ({
    number: r.number, id: r.id, kind: r.kind, actor: r.actor, agent: r.agentKey?.name ?? null, createdAt: r.createdAt, note: r.note,
    proposal: r.proposal, rollsBackRevisionId: r.rollsBackRevisionId,
    changeCount: r.changes.length,
    changes: r.kind === 'seed' || r.kind === 'copy' ? [] : r.changes.map((c) => ({ op: c.op, entityType: c.entityType, entityId: c.entityId, field: c.field, before: c.beforeValue, after: c.afterValue })),
  }));
}
