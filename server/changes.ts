/**
 * The one way design data changes: a list of field-level ops applied inside a transaction and
 * recorded as an append-only revision (revisions + revision_changes). Used by editor saves,
 * approved proposals, measurements, and rollbacks.
 */
import type { Actor, RevisionKind } from '@prisma/client';
import { ApiError } from './util.js';
import { checkParam } from './templates.js';
import { coerce, def, delegate, fieldSpec, ownerOf, ser, workspaceRoomIds, type Tx } from './entities.js';
import { assertNameFree, assertNotArchived, clean, roomKeysOf } from './designs.js';

export type Op =
  | { op: 'create'; entityType: string; tempRef?: string; fields: Record<string, unknown>; id?: number }
  | { op: 'update'; entityType: string; entityId: number; field: string; after: unknown; before?: string | null }
  | { op: 'delete'; entityType: string; entityId: number };

export type RevChange = {
  op: 'create' | 'update' | 'delete'; entityType: string; entityId: number; field?: string | null;
  beforeValue?: string | null; afterValue?: string | null;
};

export type ApplyCtx = {
  /**
   * The workspace being changed, or null for Current. Current's structure changes only through
   * rescans, measurements and rollbacks; its furniture and colors only through approved proposals
   * (and rollbacks). Nothing edits Current directly.
   */
  workspaceId: number | null;
  /** 'revert' = undo/redo from the editor: the inverse of one earlier revision, applied as a new one. */
  mode: 'save' | 'proposal' | 'rollback' | 'measurement' | 'rescan' | 'revert';
  /**
   * Internal callers only (scan promotion): may set system fields and create Current rooms.
   * Never set from request input.
   */
  trusted?: boolean;
  /** For "new workspace" proposals: ids in the base workspace -> ids in the copy. */
  idMap?: Map<string, number>;
  /** Refuse to apply an update whose stored `before` no longer matches (proposals). */
  checkBefore?: boolean;
  /** Measurement pins write pinned fields; everything else must not. */
  allowPinned?: boolean;
};

export async function isPinned(tx: Tx, entityType: string, entityId: number, field: string) {
  const pin = await tx.measurement.findFirst({
    where: { entityType, entityId, field, source: 'manual', isOverride: true, unpinnedAt: null, withdrawnAt: null },
    select: { id: true },
  });
  return !!pin;
}

export async function lockWorkspace(tx: Tx, workspaceId: number) {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  return ws;
}

const mapId = (ctx: ApplyCtx, type: string, id: number) => ctx.idMap?.get(`${type}:${id}`) ?? id;

/** What Current holds besides structure, and what an approved proposal may change there. */
export const CURRENT_FURNISHING = ['placement', 'placement_param', 'room_style', 'furniture_item'] as const;

/** Rooms of Current (not drafts). */
async function currentRoomIds(tx: Tx) {
  const rows = await tx.room.findMany({ where: { draftWorkspaceId: null }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

export async function applyOps(tx: Tx, ops: Op[], ctx: ApplyCtx) {
  const changes: RevChange[] = [];
  const skipped: string[] = [];
  const refs: Record<string, number> = {};
  const W = ctx.workspaceId;
  // Values replayed from the revision history (rollback, undo/redo) may restore system fields.
  const allowSystem = ctx.mode === 'rollback' || ctx.mode === 'revert' || ctx.trusted === true;
  if (W === null && !(ctx.mode === 'rollback' || (ctx.mode === 'rescan' && ctx.trusted) || ctx.mode === 'measurement' || ctx.mode === 'proposal'))
    throw new ApiError(403, 'current_locked', 'Current only changes through a promoted scan, a measurement, an approved proposal, or a rollback');
  const scopeName = W === null ? 'Current' : `workspace ${W}`;
  if (W !== null) await assertNotArchived(tx, W); // archived designs are read-only
  let roomIds: Set<number> | null = null;
  const rooms = async () => (roomIds ??= W === null ? await currentRoomIds(tx) : await workspaceRoomIds(tx, W));

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
    const owner = await ownerOf(tx, type, row);
    if (owner === 'global' || owner === W) return;
    throw new ApiError(403, 'not_in_workspace', `${type} ${row.id ?? ''} isn't part of ${scopeName}${owner === null ? ' (it belongs to Current)' : ''}`);
  };

  const checkRefs = async (type: string, data: Record<string, any>) => {
    if ('roomId' in data && data.roomId != null) {
      const room = await tx.room.findUnique({ where: { id: data.roomId } });
      if (!room) throw new ApiError(400, 'invalid_ref', `room ${data.roomId} not found`);
      const linked = type === 'placement' || type === 'room_style'; // may sit in a Current room the workspace links
      if (linked ? !(await rooms()).has(room.id) : room.draftWorkspaceId !== W)
        throw new ApiError(403, 'not_in_workspace', `room ${room.id} isn't ${linked ? 'in' : 'a room of'} ${scopeName}`);
    }
    if (type === 'placement' && data.itemId != null && !(await tx.furnitureItem.findUnique({ where: { id: data.itemId } })))
      throw new ApiError(400, 'invalid_ref', `furniture_item ${data.itemId} not found`);
    if (type === 'placement' && data.replacesPlacementId != null && !(await tx.placement.findUnique({ where: { id: data.replacesPlacementId } })))
      throw new ApiError(400, 'invalid_ref', `placement ${data.replacesPlacementId} not found`);
    if ('wallId' in data && data.wallId != null) {
      const wall = await tx.wall.findUnique({ where: { id: data.wallId }, include: { room: true } });
      if (!wall || wall.room.draftWorkspaceId !== W) throw new ApiError(403, 'not_in_workspace', `wall ${data.wallId} isn't in ${scopeName}`);
    }
    if (type === 'placement' && data.templateId != null && !(await tx.furnitureTemplate.findUnique({ where: { id: data.templateId } })))
      throw new ApiError(400, 'invalid_ref', `template ${data.templateId} not found (see list_templates)`);
    if (type === 'placement' && data.modelId != null && !(await tx.furnitureModel.findUnique({ where: { id: data.modelId } })))
      throw new ApiError(400, 'invalid_ref', `model ${data.modelId} not found`);
    if (type === 'placement_param' && data.placementId != null) {
      const pl = await tx.placement.findUnique({ where: { id: data.placementId } });
      if (!pl || pl.workspaceId !== W) throw new ApiError(403, 'not_in_workspace', `placement ${data.placementId} isn't in ${scopeName}`);
    }
  };

  /** Template parameter values must fit the placement's template (not checked when restoring history). */
  const checkTemplateParam = async (placementId: number, key: string, value: unknown) => {
    if (ctx.mode === 'rollback' || ctx.mode === 'revert') return String(value);
    const pl = await tx.placement.findUnique({ where: { id: placementId }, include: { template: true } });
    if (!pl?.template) throw new ApiError(400, 'no_template', `placement ${placementId} has no template; set placement.templateId first`);
    return checkParam(pl.template.slug, key, value);
  };

  const snapshot = (type: string, row: any) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(def(type).fields)) out[k] = row[k];
    return out;
  };

  for (const op of ops) {
    const d = def(op.entityType);
    const model = delegate(tx, op.entityType);

    if (W === null && op.entityType === 'workspace') throw new ApiError(400, 'not_in_workspace', 'Current is not a workspace');
    if (W === null && ctx.mode === 'proposal' && !(CURRENT_FURNISHING as readonly string[]).includes(op.entityType))
      throw new ApiError(403, 'current_locked', `A proposal for Current can change furniture and colors (${CURRENT_FURNISHING.join(', ')}); ${op.entityType} changes only through scans and measurements`);

    if (op.op === 'create') {
      // Current rooms are created only by a trusted scan promotion (or re-created by a rollback).
      const currentRoom = op.entityType === 'room' && W === null && allowSystem;
      if (!d.create && !currentRoom) throw new ApiError(400, 'not_creatable', `${op.entityType} can't be created by a change`);
      const data: Record<string, any> = {};
      for (const [k, v] of Object.entries(op.fields ?? {})) data[k] = resolve(op.entityType, k, v);
      if (!allowSystem) {
        const missing = d.required.filter((k) => data[k] === undefined);
        if (missing.length) throw new ApiError(400, 'missing_fields', `${op.entityType} create needs ${missing.join(', ')}`);
      }
      if (op.entityType === 'placement' && !allowSystem) data.workspaceId = W;
      if (op.entityType === 'room_style') {
        data.workspaceId = W;
        if (await tx.roomStyle.findFirst({ where: { workspaceId: W, roomId: data.roomId } }))
          throw new ApiError(409, 'exists', `room ${data.roomId} already has colors in ${scopeName}; update that room_style instead`);
      }
      if (currentRoom) data.draftWorkspaceId = null;
      await checkRefs(op.entityType, data);
      if (op.entityType === 'placement_param') {
        data.value = await checkTemplateParam(data.placementId, data.key, data.value);
        if (await tx.placementParam.findFirst({ where: { placementId: data.placementId, key: data.key } }))
          throw new ApiError(409, 'exists', `placement ${data.placementId} already has ${data.key}; update it instead`);
      }
      if (op.entityType === 'placement' && data.workspaceId !== W) throw new ApiError(403, 'not_in_workspace', 'placement must be in this workspace');
      if (op.id != null) {
        // Re-creating a deleted row (rollback, undo): its id must still be free.
        if (await model.findUnique({ where: { id: op.id } })) throw new ApiError(409, 'stale', `${op.entityType} ${op.id} already exists again; it changed since`);
        data.id = op.id;
      }
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
        throw new ApiError(409, 'stale', `${op.entityType} ${id} ${op.field} changed since ${ctx.mode === 'revert' ? 'that edit' : 'this was proposed'} (expected ${op.before}, now ${ser(row[op.field])})`);
      if (ser(row[op.field]) === ser(val)) continue;
      if (op.entityType === 'room_style' && op.field === 'roomId') throw new ApiError(400, 'unknown_field', 'room_style.roomId can\'t change; create a new room_style');
      if (op.entityType === 'placement_param' && (op.field === 'placementId' || op.field === 'key')) throw new ApiError(400, 'unknown_field', `placement_param.${op.field} can't change; delete and create instead`);
      if (op.field in { roomId: 1, wallId: 1, itemId: 1, replacesPlacementId: 1, templateId: 1, modelId: 1 }) await checkRefs(op.entityType, { ...row, [op.field]: val });
      let stored = val;
      if (op.entityType === 'workspace' && op.field === 'name') {
        // Design names are unique per room (live designs, case-insensitive).
        stored = clean(String(val ?? ''));
        const { keys, labels } = await roomKeysOf(tx, id);
        await assertNameFree(tx, row.houseId, stored as string, keys, labels, id);
        if (ser(row.name) === ser(stored)) continue;
      }
      if (op.entityType === 'placement_param' && op.field === 'value') {
        stored = await checkTemplateParam(row.placementId, row.key, val);
        if (ser(row.value) === ser(stored)) continue;
      }
      await model.update({ where: { id }, data: { [op.field]: stored } });
      changes.push({ op: 'update', entityType: op.entityType, entityId: id, field: op.field, beforeValue: ser(row[op.field]), afterValue: ser(stored) });
      continue;
    }

    // delete
    if (!d.delete) {
      // Rolling back past the creation of a catalog item removes it again, unless something still uses it.
      if ((ctx.mode === 'rollback' || ctx.mode === 'revert') && op.entityType === 'furniture_item') {
        if (await tx.placement.count({ where: { itemId: id } })) { skipped.push(`furniture_item ${id} (still used)`); continue; }
      } else if (ctx.mode === 'rollback' && op.entityType === 'room' && W === null) {
        // Rolling back the scan that created a Current room removes it again, once its walls are gone.
        const [w, f] = await Promise.all([tx.wall.count({ where: { roomId: id } }), tx.fixture.count({ where: { roomId: id } })]);
        if (w || f) { skipped.push(`room ${id} (still has walls or fixtures)`); continue; }
      } else throw new ApiError(400, 'not_deletable', `${op.entityType} can't be deleted by a change`);
    }
    if (op.entityType === 'wall') {
      const [o, f] = await Promise.all([tx.opening.count({ where: { wallId: id } }), tx.fixture.count({ where: { wallId: id } })]);
      if (o || f) throw new ApiError(409, 'has_children', `wall ${id} still has openings or fixtures; delete those first`);
    }
    if (op.entityType === 'placement' && (await tx.placement.count({ where: { replacesPlacementId: id } })))
      throw new ApiError(409, 'has_children', `placement ${id} is replaced by another placement; change that one first`);
    if (op.entityType === 'placement') {
      // Its template parameters go with it, recorded first so a rollback restores them too.
      for (const prow of await tx.placementParam.findMany({ where: { placementId: id }, orderBy: { id: 'asc' } })) {
        await tx.placementParam.delete({ where: { id: prow.id } });
        changes.push({ op: 'delete', entityType: 'placement_param', entityId: prow.id });
        for (const [k, v] of Object.entries(snapshot('placement_param', prow)))
          if (v !== null && v !== undefined) changes.push({ op: 'delete', entityType: 'placement_param', entityId: prow.id, field: k, beforeValue: ser(v) });
      }
    }
    await model.delete({ where: { id } });
    changes.push({ op: 'delete', entityType: op.entityType, entityId: id });
    for (const [k, v] of Object.entries(snapshot(op.entityType, row)))
      if (v !== null && v !== undefined) changes.push({ op: 'delete', entityType: op.entityType, entityId: id, field: k, beforeValue: ser(v) });
  }
  return { changes, skipped, refs };
}

/** Lock the house row; Current's revision counter lives on it. */
export async function lockHouse(tx: Tx, houseId: number) {
  await tx.$queryRaw`SELECT id FROM houses WHERE id = ${houseId} FOR UPDATE`;
  const house = await tx.house.findUnique({ where: { id: houseId } });
  if (!house) throw new ApiError(404, 'house_not_found', `House ${houseId} not found`);
  return house;
}

/**
 * Record a revision. Revision numbers are always assigned here, from the workspace's counter or,
 * for Current (workspaceId null), from houses.current_revision under a row lock.
 */
export async function commitRevision(
  tx: Tx,
  p: { workspaceId: number | null; houseId?: number; kind: RevisionKind; actor: Actor; agentKeyId?: number | null; proposalId?: number | null; note?: string | null; rollsBackRevisionId?: number | null; changes: RevChange[] },
) {
  let houseId: number, number: number, scope: string;
  if (p.workspaceId === null) {
    if (p.houseId == null) throw new ApiError(500, 'internal', 'Current revision needs a house');
    const house = await lockHouse(tx, p.houseId);
    houseId = house.id; number = (house.currentRevision ?? 0) + 1; scope = 'current';
  } else {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: p.workspaceId } });
    houseId = ws.houseId; number = ws.revision + 1; scope = `workspace:${ws.id}`;
  }
  const rev = await tx.revision.create({
    data: {
      houseId, workspaceId: p.workspaceId, scope, number, actor: p.actor, kind: p.kind,
      agentKeyId: p.agentKeyId ?? null, proposalId: p.proposalId ?? null, rollsBackRevisionId: p.rollsBackRevisionId ?? null,
      note: p.note?.slice(0, 1000) ?? null,
    },
  });
  if (p.changes.length) await tx.revisionChange.createMany({ data: p.changes.map((c, seq) => ({ ...c, seq, revisionId: rev.id, field: c.field ?? null })) });
  if (p.workspaceId === null) await tx.house.update({ where: { id: houseId }, data: { currentRevision: number } });
  else await tx.workspace.update({ where: { id: p.workspaceId }, data: { revision: number } });
  return rev;
}

/** Michael's own edit from the editor: applied directly, recorded as a "save" revision. */
export async function saveChanges(tx: Tx, workspaceId: number, baseRevision: number, ops: Op[], note?: string) {
  const ws = await lockWorkspace(tx, workspaceId);
  if (ws.revision !== baseRevision)
    throw new ApiError(409, 'conflict', `Workspace is at revision ${ws.revision}, your edit was based on ${baseRevision}. Reload to get the latest.`, { revision: ws.revision });
  const { changes, refs } = await applyOps(tx, ops, { workspaceId, mode: 'save' });
  if (!changes.length) return { revision: ws.revision, refs, unchanged: true };
  const rev = await commitRevision(tx, { workspaceId, kind: 'save', actor: 'michael', note: note ?? 'Edit in the editor', changes });
  return { revision: rev.number, refs, unchanged: false };
}

/** Inverse ops for one revision's change rows (newest first). */
export function inverseOps(rows: { seq: number; op: string; entityType: string; entityId: number; field: string | null; beforeValue: string | null; afterValue?: string | null }[]): Op[] {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const groups: Op[] = [];
  let i = 0;
  while (i < sorted.length) {
    const r = sorted[i];
    if (r.op === 'update' && r.field) {
      // `before` = what the revision set; undo refuses if it changed since (rollbacks don't check).
      groups.push({ op: 'update', entityType: r.entityType, entityId: r.entityId, field: r.field, after: r.beforeValue, before: r.afterValue ?? null });
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

/**
 * Undo (or redo) from the editor: apply the inverse of one revision of a workspace as a new, normal
 * revision. History is never rewritten. The caller's base revision must be the latest (else 409
 * conflict), and every value the revision set must still be in place (else 409 stale), so an undo
 * never overwrites a later change made elsewhere. Redo = undo of the undo revision.
 */
export async function revertRevision(tx: Tx, workspaceId: number, baseRevision: number, number: number, note?: string) {
  const ws = await lockWorkspace(tx, workspaceId);
  if (ws.revision !== baseRevision)
    throw new ApiError(409, 'conflict', `Workspace is at revision ${ws.revision}, your undo was based on ${baseRevision}. Reload to get the latest.`, { revision: ws.revision });
  const target = await tx.revision.findFirst({ where: { workspaceId, number }, include: { changes: true } });
  if (!target) throw new ApiError(404, 'revision_not_found', `Revision ${number} of workspace ${workspaceId} not found`);
  if (target.kind === 'seed' || target.kind === 'copy') throw new ApiError(409, 'before_start', `Revision ${number} is where this workspace started; it can't be undone`);
  const { changes } = await applyOps(tx, inverseOps(target.changes), { workspaceId, mode: 'revert', checkBefore: true });
  if (!changes.length) return { revision: ws.revision, unchanged: true, reverted: number };
  const rev = await commitRevision(tx, { workspaceId, kind: 'save', actor: 'michael', rollsBackRevisionId: target.id, changes, note: (note || `Undid revision ${number}`).slice(0, 1000) });
  return { revision: rev.number, unchanged: false, reverted: number };
}

/** Roll a workspace back to the state right after revision `toRevision`. The rollback is itself a new revision. */
export async function rollbackWorkspace(tx: Tx, workspaceId: number, toRevision: number, note?: string) {
  const ws = await lockWorkspace(tx, workspaceId);
  return rollbackScope(tx, { workspaceId, houseId: ws.houseId, current: ws.revision, floor: 0 }, toRevision, note);
}

/**
 * Roll Current back to the state right after Current revision `toRevision` (>= 1: Current starts at
 * its first promoted scan). Same inverse-ops path as workspaces; pinned fields are kept.
 */
export async function rollbackCurrent(tx: Tx, houseId: number, toRevision: number, note?: string) {
  const house = await lockHouse(tx, houseId);
  if (house.currentRevision == null) throw new ApiError(409, 'no_current', 'There is no Current yet');
  return rollbackScope(tx, { workspaceId: null, houseId, current: house.currentRevision, floor: 1 }, toRevision, note);
}

async function rollbackScope(tx: Tx, s: { workspaceId: number | null; houseId: number; current: number; floor: number }, toRevision: number, note?: string) {
  if (!Number.isInteger(toRevision) || toRevision < s.floor || toRevision >= s.current)
    throw new ApiError(400, 'invalid_revision', s.current - 1 < s.floor ? 'Nothing to roll back to yet' : `Pick a revision between ${s.floor} and ${s.current - 1}`);
  const where = s.workspaceId === null ? { houseId: s.houseId, scope: 'current' } : { workspaceId: s.workspaceId };
  const later = await tx.revision.findMany({ where: { ...where, number: { gt: toRevision } }, orderBy: { number: 'desc' }, include: { changes: true } });
  const base = later.find((r) => r.kind === 'seed' || r.kind === 'copy');
  if (base) throw new ApiError(409, 'before_start', `Can't roll back past revision ${base.number} (${base.kind}), where this ${s.workspaceId === null ? 'Current' : 'workspace'} started`);
  const ops = later.flatMap((r) => inverseOps(r.changes));
  const { changes, skipped } = await applyOps(tx, ops, { workspaceId: s.workspaceId, mode: 'rollback' });
  const target = await tx.revision.findFirst({ where: { ...where, number: toRevision } });
  const rev = await commitRevision(tx, {
    workspaceId: s.workspaceId, houseId: s.houseId, kind: 'rollback', actor: 'michael', rollsBackRevisionId: target?.id ?? null, changes,
    note: [note || `Rolled back to revision ${toRevision}`, skipped.length ? `Kept pinned: ${skipped.join('; ')}` : ''].filter(Boolean).join('. '),
  });
  return { revision: rev.number, skipped };
}

export async function getHistory(tx: Tx, workspaceId: number | { currentOf: number }, limit = 50) {
  const revs = await tx.revision.findMany({
    where: typeof workspaceId === 'number' ? { workspaceId } : { houseId: workspaceId.currentOf, scope: 'current' }, orderBy: { number: 'desc' }, take: Math.min(Math.max(limit, 1), 200),
    include: { changes: { orderBy: { seq: 'asc' } }, proposal: { select: { id: true, title: true } }, agentKey: { select: { name: true } } },
  });
  return revs.map((r) => ({
    number: r.number, id: r.id, kind: r.kind, actor: r.actor, agent: r.agentKey?.name ?? null, createdAt: r.createdAt, note: r.note,
    proposal: r.proposal, rollsBackRevisionId: r.rollsBackRevisionId,
    changeCount: r.changes.length,
    changes: r.kind === 'seed' || r.kind === 'copy' ? [] : r.changes.map((c) => ({ op: c.op, entityType: c.entityType, entityId: c.entityId, field: c.field, before: c.beforeValue, after: c.afterValue })),
  }));
}
