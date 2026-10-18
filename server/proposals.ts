/**
 * Proposals (change requests). Agents and inspiration create them; only Michael approves or rejects.
 * Approving applies the field-level changes as a new revision of the target workspace (or of a new
 * workspace copied from the base). Rejecting changes nothing and keeps the proposal for the record.
 */
import { z } from 'zod';
import type { Actor, Prisma } from '@prisma/client';
import { ApiError } from './util.js';
import { coerce, def, delegate, fieldSpec, ser, type Tx } from './entities.js';
import { applyOps, commitRevision, lockHouse, lockWorkspace, rollbackCurrent, rollbackWorkspace, type Op } from './changes.js';
import { copyWorkspace, getCurrentView, getWorkspaceView } from './workspaces.js';
import { prisma } from './db.js';
import { listPhotos } from './photos.js';
import { recordMeasurement } from './measurements.js';

export const COST_STEPS = ['paint', 'outlets', 'lighting', 'window', 'furniture', 'rug', 'decor', 'other'] as const;

const entityType = z.enum(['placement', 'placement_param', 'room_style', 'furniture_item', 'room', 'wall', 'opening', 'fixture', 'workspace']);
export const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), entityType, entityId: z.number().int(), field: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({
    op: z.literal('create'), entityType,
    tempRef: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/).optional().describe('Name for this new row; later changes can point at it as "$<tempRef>"'),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  z.object({ op: z.literal('delete'), entityType, entityId: z.number().int() }),
]);

export const proposalShape = {
  title: z.string().min(3).max(200),
  rationale: z.string().min(1).max(5000).describe('Why this fits the room and the design'),
  workspaceId: z.number().int().optional().describe('Target workspace. Omit and pass newWorkspace to propose a new design, or current: true for Current.'),
  current: z.boolean().optional().describe('Target Current, the house as it is now: only furniture (placement, placement_param, furniture_item) and room colors (room_style). Its structure changes only through scans and measurements.'),
  newWorkspace: z.object({ name: z.string().min(1).max(120), copyFromWorkspaceId: z.number().int() }).optional()
    .describe('Create a new workspace on approval, copied from copyFromWorkspaceId. Entity ids in changes refer to that source workspace.'),
  roomIds: z.array(z.number().int()).min(1).max(20),
  source: z.object({
    kind: z.enum(['x_bookmark', 'bot', 'manual']),
    url: z.string().url().max(1000).optional(),
    imageUrl: z.string().url().max(1000).optional(),
  }),
  changes: z.array(changeSchema).min(1).max(200),
  photoIds: z.array(z.number().int()).max(20).optional().describe('Room photos this proposal refers to (ids from list_room_photos)'),
  cost: z.object({
    steps: z.array(z.object({
      step: z.enum(COST_STEPS),
      changes: z.string().min(1).max(1000).describe('What this step changes'),
      lowUsd: z.number().min(0).max(1_000_000),
      highUsd: z.number().min(0).max(1_000_000),
    })).min(1).max(30),
  }).describe('Cost to make the change, step by step, low/high in US dollars'),
};
export const proposalSchema = z.object(proposalShape);
export type ProposalInput = z.infer<typeof proposalSchema>;

/** Rebuild ops from stored proposal_changes rows. */
export function opsFromRows(rows: { seq: number; op: string; entityType: string; entityId: number | null; tempRef: string | null; field: string | null; beforeValue: string | null; afterValue: string | null }[]): Op[] {
  const ops: Op[] = [];
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.op === 'update') ops.push({ op: 'update', entityType: r.entityType, entityId: r.entityId!, field: r.field!, after: r.afterValue, before: r.beforeValue });
    else if (r.op === 'create' && !r.field) {
      const fields: Record<string, unknown> = {};
      while (i + 1 < sorted.length && sorted[i + 1].op === 'create' && sorted[i + 1].field && sorted[i + 1].tempRef === r.tempRef && sorted[i + 1].entityType === r.entityType) {
        i++;
        fields[sorted[i].field!] = sorted[i].afterValue;
      }
      ops.push({ op: 'create', entityType: r.entityType, tempRef: r.tempRef ?? undefined, fields });
    } else if (r.op === 'delete' && !r.field) {
      ops.push({ op: 'delete', entityType: r.entityType, entityId: r.entityId! });
      while (i + 1 < sorted.length && sorted[i + 1].op === 'delete' && sorted[i + 1].field && sorted[i + 1].entityId === r.entityId) i++;
    }
  }
  return ops;
}

const ROLLBACK = Symbol('rollback');
/** Run fn in a transaction and always roll it back (dry runs and previews). */
export async function dryRun<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await prisma.$transaction(async (tx) => { out = await fn(tx); throw ROLLBACK; }, { timeout: 30_000 });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as T;
}

/** Apply a proposal's ops to its target (or a fresh copy of its base). Returns the workspace changed. */
async function applyProposal(tx: Tx, p: { id: number; houseId: number; targetCurrent: boolean; targetWorkspaceId: number | null; baseWorkspaceId: number | null; newWorkspaceName: string | null; createdBy: Actor }, ops: Op[], forReal: boolean) {
  let workspaceId: number | null;
  let idMap: Map<string, number> | undefined;
  if (p.targetCurrent) {
    const house = await lockHouse(tx, p.houseId);
    if (house.currentRevision == null) throw new ApiError(409, 'no_current', 'There is no Current yet');
    workspaceId = null;
  } else if (p.targetWorkspaceId != null) {
    workspaceId = (await lockWorkspace(tx, p.targetWorkspaceId)).id;
  } else {
    if (p.baseWorkspaceId == null) throw new ApiError(409, 'no_base', 'The workspace this proposal copies from no longer exists');
    const copy = await copyWorkspace(tx, p.baseWorkspaceId, p.newWorkspaceName || 'New design', p.createdBy, forReal ? p.id : undefined, 'suffix');
    workspaceId = copy.workspace.id;
    idMap = copy.idMap;
  }
  const result = await applyOps(tx, ops, { workspaceId, mode: 'proposal', checkBefore: true, idMap });
  return { workspaceId, ...result };
}

export async function createProposal(input: ProposalInput, by: { actor: Actor; agentKeyId?: number }) {
  const p = proposalSchema.parse(input);
  const current = p.current === true;
  if ([p.workspaceId != null, p.newWorkspace != null, current].filter(Boolean).length !== 1)
    throw new ApiError(400, 'target_required', 'Pass exactly one of workspaceId, newWorkspace or current: true');
  for (const s of p.cost.steps) if (s.highUsd < s.lowUsd) throw new ApiError(400, 'invalid_cost', `Cost step "${s.changes}": high is below low`);

  // Rooms must be in the target.
  let houseId: number, baseRevision: number, view: { rooms: { id: number; label: string }[] }, scopeName: string;
  if (current) {
    const house = await prisma.house.findFirst({ orderBy: { id: 'asc' } });
    if (!house || house.currentRevision == null) throw new ApiError(409, 'no_current', 'There is no Current yet');
    houseId = house.id; baseRevision = house.currentRevision; view = await getCurrentView(prisma); scopeName = 'Current';
  } else {
    const sourceWsId = p.workspaceId ?? p.newWorkspace!.copyFromWorkspaceId;
    const sourceWs = await prisma.workspace.findUnique({ where: { id: sourceWsId } });
    if (!sourceWs) throw new ApiError(404, 'workspace_not_found', `Workspace ${sourceWsId} not found`);
    if (p.workspaceId != null && sourceWs.archivedAt) throw new ApiError(409, 'archived', `"${sourceWs.name}" is archived. Restore it before proposing changes to it.`);
    houseId = sourceWs.houseId; baseRevision = sourceWs.revision; view = await getWorkspaceView(prisma, sourceWsId); scopeName = `workspace ${sourceWsId}`;
  }
  const roomIds = new Set(view.rooms.map((r) => r.id));
  const badRoom = p.roomIds.find((r) => !roomIds.has(r));
  if (badRoom != null) throw new ApiError(400, 'room_not_in_workspace', `Room ${badRoom} isn't in ${scopeName}. Rooms: ${view.rooms.map((r) => `${r.id} ${r.label}`).join(', ')}`);

  // Expand to stored rows, filling "before" from the live data.
  const rows: Prisma.ProposalChangeCreateManyProposalInput[] = [];
  let seq = 0;
  for (const c of p.changes) {
    def(c.entityType);
    if (c.op === 'update') {
      fieldSpec(c.entityType, c.field);
      if (!(typeof c.value === 'string' && c.value.startsWith('$'))) coerce(c.entityType, c.field, c.value);
      const row = await delegate(prisma, c.entityType).findUnique({ where: { id: c.entityId } });
      if (!row) throw new ApiError(404, 'entity_not_found', `${c.entityType} ${c.entityId} not found`);
      rows.push({ seq: seq++, op: 'update', entityType: c.entityType, entityId: c.entityId, field: c.field, beforeValue: ser(row[c.field]), afterValue: ser(c.value) });
    } else if (c.op === 'create') {
      rows.push({ seq: seq++, op: 'create', entityType: c.entityType, tempRef: c.tempRef ?? `new${seq}` });
      const ref = rows[rows.length - 1].tempRef;
      for (const [k, v] of Object.entries(c.fields)) {
        fieldSpec(c.entityType, k);
        rows.push({ seq: seq++, op: 'create', entityType: c.entityType, tempRef: ref, field: k, afterValue: ser(v) });
      }
    } else {
      const row = await delegate(prisma, c.entityType).findUnique({ where: { id: c.entityId } });
      if (!row) throw new ApiError(404, 'entity_not_found', `${c.entityType} ${c.entityId} not found`);
      rows.push({ seq: seq++, op: 'delete', entityType: c.entityType, entityId: c.entityId });
      for (const k of Object.keys(def(c.entityType).fields))
        if (row[k] != null) rows.push({ seq: seq++, op: 'delete', entityType: c.entityType, entityId: c.entityId, field: k, beforeValue: ser(row[k]) });
    }
  }
  const ops = opsFromRows(rows.map((r) => ({ entityId: null, tempRef: null, field: null, beforeValue: null, afterValue: null, ...r })) as any);

  // Dry run: the whole change list must apply cleanly (ownership, refs, pins) before it is stored.
  await dryRun((tx) => applyProposal(tx, { id: 0, houseId, targetCurrent: current, targetWorkspaceId: p.workspaceId ?? null, baseWorkspaceId: p.newWorkspace?.copyFromWorkspaceId ?? null, newWorkspaceName: p.newWorkspace?.name ?? null, createdBy: by.actor }, ops, false));

  const photoIds = [...new Set(p.photoIds ?? [])];
  if (photoIds.length) {
    const found = await prisma.scanPhoto.count({ where: { id: { in: photoIds } } });
    if (found !== photoIds.length) throw new ApiError(400, 'photo_not_found', 'One or more photoIds do not exist (see list_room_photos)');
  }

  const cents = (usd: number) => Math.round(usd * 100);
  const created = await prisma.proposal.create({
    data: {
      houseId, createdBy: by.actor, agentKeyId: by.agentKeyId ?? null,
      sourceKind: p.source.kind, sourceUrl: p.source.url, sourceImageUrl: p.source.imageUrl, targetCurrent: current,
      targetWorkspaceId: p.workspaceId ?? null, newWorkspaceName: p.newWorkspace?.name ?? null, baseWorkspaceId: p.newWorkspace?.copyFromWorkspaceId ?? null,
      title: p.title, rationale: p.rationale, baseRevision,
      costLowCents: p.cost.steps.reduce((a, s) => a + cents(s.lowUsd), 0),
      costHighCents: p.cost.steps.reduce((a, s) => a + cents(s.highUsd), 0),
      rooms: { create: p.roomIds.map((roomId) => ({ roomId })) },
      changes: { createMany: { data: rows } },
      costSteps: { create: p.cost.steps.map((s, i) => ({ sort: i, step: s.step, changesText: s.changes, lowCents: cents(s.lowUsd), highCents: cents(s.highUsd) })) },
      photos: { create: photoIds.map((photoId) => ({ photoId })) },
    },
  });
  return getProposal(created.id);
}

// ---------------------------------------------------------------------------
// Measurement proposals (notes from the iPhone). Approving records each value as a "measured"
// measurement; pins still win. They target Current rooms, which proposals can't otherwise change.
// ---------------------------------------------------------------------------
export const suggestionSchema = z.object({
  entityType: z.enum(['room', 'wall', 'opening']),
  entityId: z.number().int(),
  field: z.string().max(40),
  valueIn: z.number().int().min(1).max(2000),
  note: z.string().max(300).optional(),
});
export type MeasurementSuggestion = z.infer<typeof suggestionSchema>;

export async function createMeasurementProposal(p: { roomId: number; notes: string; suggestions: MeasurementSuggestion[]; method: string }) {
  const suggestions = z.array(suggestionSchema).min(1).max(30).parse(p.suggestions);
  const room = await prisma.room.findUnique({ where: { id: p.roomId }, include: { walls: { include: { openings: true } } } });
  if (!room) throw new ApiError(404, 'room_not_found', `Room ${p.roomId} not found`);
  const rows: { seq: number; entityType: string; entityId: number; field: string; valueIn: number; beforeIn: number | null; note: string | null }[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    if (!def(s.entityType).pinnable.includes(s.field)) throw new ApiError(400, 'not_measurable', `${s.entityType}.${s.field} isn't a measurement. Measurable: ${def(s.entityType).pinnable.join(', ')}`);
    const row: any = s.entityType === 'room' ? (s.entityId === room.id ? room : null)
      : s.entityType === 'wall' ? room.walls.find((w) => w.id === s.entityId)
      : room.walls.flatMap((w) => w.openings).find((o) => o.id === s.entityId);
    if (!row) throw new ApiError(400, 'not_in_room', `${s.entityType} ${s.entityId} isn't part of ${room.label}`);
    const k = `${s.entityType}:${s.entityId}:${s.field}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ seq: rows.length, entityType: s.entityType, entityId: s.entityId, field: s.field, valueIn: s.valueIn, beforeIn: row[s.field] ?? null, note: s.note?.slice(0, 500) ?? null });
  }
  const notes = p.notes.trim().slice(0, 4000);
  const created = await prisma.proposal.create({
    data: {
      houseId: room.houseId, createdBy: 'michael', kind: 'measurements', sourceKind: 'manual',
      title: `Measurements from notes: ${room.label}`.slice(0, 200),
      rationale: `${notes}\n\n(Parsed on the iPhone by ${p.method === 'on_device_model' ? "Apple's on-device model" : p.method === 'keywords' ? 'keyword matching' : 'hand entry'}. Check each value before approving.)`,
      baseRevision: 0, costLowCents: 0, costHighCents: 0,
      rooms: { create: [{ roomId: room.id }] },
      measurements: { createMany: { data: rows } },
      costSteps: { create: [{ sort: 0, step: 'other', changesText: 'Record measurements (nothing to buy)', lowCents: 0, highCents: 0 }] },
    },
  });
  return getProposal(created.id);
}

async function labelFor(entityType: string, id: number | null): Promise<string | null> {
  if (id == null) return null;
  switch (entityType) {
    case 'placement': return (await prisma.placement.findUnique({ where: { id }, include: { item: true } }))?.item.name ?? null;
    case 'furniture_item': return (await prisma.furnitureItem.findUnique({ where: { id } }))?.name ?? null;
    case 'wall': return (await prisma.wall.findUnique({ where: { id } }))?.label ?? null;
    case 'opening': return (await prisma.opening.findUnique({ where: { id } }))?.label ?? null;
    case 'fixture': return (await prisma.fixture.findUnique({ where: { id } }))?.name ?? null;
    case 'room': return (await prisma.room.findUnique({ where: { id } }))?.label ?? null;
    case 'placement_param': { const pp = await prisma.placementParam.findUnique({ where: { id }, include: { placement: { include: { item: true } } } }); return pp ? `${pp.placement.item.name} · ${pp.key}` : null; }
    case 'room_style': { const st = await prisma.roomStyle.findUnique({ where: { id }, include: { room: true } }); return st ? `${st.room.label} colors` : null; }
    case 'workspace': return (await prisma.workspace.findUnique({ where: { id } }))?.name ?? null;
  }
  return null;
}

export async function getProposal(id: number) {
  const p = await prisma.proposal.findUnique({
    where: { id },
    include: {
      changes: { orderBy: { seq: 'asc' } }, costSteps: { orderBy: { sort: 'asc' } },
      rooms: { include: { room: { select: { id: true, label: true } } } },
      targetWorkspace: { select: { id: true, name: true } }, baseWorkspace: { select: { id: true, name: true } },
      agentKey: { select: { name: true } }, revisions: { select: { number: true, workspaceId: true } },
      measurements: { orderBy: { seq: 'asc' } }, photos: { select: { photoId: true } },
    },
  });
  if (!p) throw new ApiError(404, 'proposal_not_found', `Proposal ${id} not found`);
  const photos = p.photos.length ? await listPhotos({ ids: p.photos.map((x) => x.photoId) }) : [];
  const ops = opsFromRows(p.changes);
  const diff = await Promise.all(ops.map(async (o) => {
    if (o.op === 'update') return { op: o.op, entityType: o.entityType, entityId: o.entityId, label: await labelFor(o.entityType, o.entityId), field: o.field, before: o.before ?? null, after: o.after as string | null };
    if (o.op === 'delete') return { op: o.op, entityType: o.entityType, entityId: o.entityId, label: await labelFor(o.entityType, o.entityId) };
    return { op: o.op, entityType: o.entityType, tempRef: o.tempRef, label: (o.fields.name as string) ?? null, fields: o.fields };
  }));
  const measurementRows = await Promise.all(p.measurements.map(async (m) => ({
    op: 'measure' as const, entityType: m.entityType, entityId: m.entityId, label: await labelFor(m.entityType, m.entityId),
    field: m.field, before: m.beforeIn == null ? null : String(m.beforeIn), after: String(m.valueIn), note: m.note,
  })));
  const usd = (c: number | null) => (c == null ? null : c / 100);
  return {
    kind: p.kind,
    id: p.id, title: p.title, status: p.status, createdAt: p.createdAt, createdBy: p.createdBy, agent: p.agentKey?.name ?? null,
    source: { kind: p.sourceKind, url: p.sourceUrl, imageUrl: p.sourceImageUrl },
    target: p.kind === 'measurements' || p.targetCurrent ? { kind: 'current' as const, workspace: null, what: p.kind === 'measurements' ? 'measurements' as const : 'furnishings' as const }
      : p.newWorkspaceName && (p.targetWorkspaceId == null || p.status === 'approved')
      ? { kind: 'new_workspace' as const, name: p.newWorkspaceName, copyFrom: p.baseWorkspace, createdWorkspace: p.status === 'approved' ? p.targetWorkspace : null }
      : { kind: 'workspace' as const, workspace: p.targetWorkspace },
    rooms: p.rooms.map((r) => r.room),
    rationale: p.rationale,
    cost: { lowUsd: usd(p.costLowCents), highUsd: usd(p.costHighCents), steps: p.costSteps.map((s) => ({ step: s.step, changes: s.changesText, lowUsd: s.lowCents / 100, highUsd: s.highCents / 100 })) },
    baseRevision: p.baseRevision,
    changes: p.kind === 'measurements' ? measurementRows : diff,
    photos,
    decidedAt: p.decidedAt, decisionNote: p.decisionNote,
    appliedRevision: p.revisions[0] ?? null,
  };
}

export async function listProposals(filter: { status?: 'pending' | 'approved' | 'rejected'; workspaceId?: number; current?: boolean; limit?: number } = {}) {
  const rows = await prisma.proposal.findMany({
    where: {
      status: filter.status,
      ...(filter.workspaceId != null ? { OR: [{ targetWorkspaceId: filter.workspaceId }, { baseWorkspaceId: filter.workspaceId }] } : {}),
      ...(filter.current ? { OR: [{ targetCurrent: true }, { kind: 'measurements' as const }] } : {}),
    },
    orderBy: { id: 'desc' }, take: Math.min(filter.limit ?? 50, 200), select: { id: true },
  });
  return Promise.all(rows.map((r) => getProposal(r.id)));
}

/** Preview: the target workspace with the proposal applied, computed in a rolled-back transaction. */
export async function previewProposal(id: number) {
  const p = await prisma.proposal.findUnique({ where: { id }, include: { changes: true } });
  if (!p) throw new ApiError(404, 'proposal_not_found', `Proposal ${id} not found`);
  if (p.kind === 'measurements') throw new ApiError(400, 'no_preview', 'Measurement proposals have no 3D preview; the values are listed on the card');
  return dryRun(async (tx) => {
    const r = await applyProposal(tx, p, opsFromRows(p.changes), false);
    const view = r.workspaceId == null ? await getCurrentView(tx) : await getWorkspaceView(tx, r.workspaceId);
    return { ...view, preview: { proposalId: id, title: p.title, changedEntities: [...new Set(r.changes.map((c) => `${c.entityType}:${c.entityId}`))] } };
  });
}

export async function approveProposal(id: number, note?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM proposals WHERE id = ${id} FOR UPDATE`;
    const p = await tx.proposal.findUnique({ where: { id }, include: { changes: true } });
    if (!p) throw new ApiError(404, 'proposal_not_found', `Proposal ${id} not found`);
    if (p.status !== 'pending') throw new ApiError(409, 'not_pending', `Proposal ${id} is already ${p.status}`);
    if (p.kind === 'measurements') {
      const ms = await tx.proposalMeasurement.findMany({ where: { proposalId: id }, orderBy: { seq: 'asc' } });
      const results = [];
      for (const m of ms) {
        const r = await recordMeasurement(tx, {
          workspaceId: await measurementScope(tx, m.entityType, m.entityId), entityType: m.entityType, entityId: m.entityId, field: m.field,
          valueIn: m.valueIn, source: 'measured', actor: 'michael', note: `Proposal #${id}${m.note ? `: ${m.note}` : ''}`,
        });
        results.push({ entityType: m.entityType, entityId: m.entityId, field: m.field, valueIn: m.valueIn, applied: r.applied, pinned: r.pinned, revision: r.revision });
      }
      await tx.proposal.update({ where: { id }, data: { status: 'approved', decidedAt: new Date(), decisionNote: note?.slice(0, 1000) } });
      return { proposalId: id, workspaceId: null, revision: results.reduce<number | null>((a, r) => r.revision ?? a, null), measurements: results };
    }
    const r = await applyProposal(tx, p, opsFromRows(p.changes), true);
    const rev = await commitRevision(tx, {
      workspaceId: r.workspaceId, houseId: p.houseId, kind: 'proposal', actor: p.createdBy, agentKeyId: p.agentKeyId, proposalId: p.id, changes: r.changes,
      note: `Approved by Michael: #${p.id} ${p.title}${note ? ` (${note})` : ''}`,
    });
    await tx.proposal.update({ where: { id }, data: { status: 'approved', decidedAt: new Date(), decisionNote: note?.slice(0, 1000), targetWorkspaceId: r.workspaceId } });
    return { proposalId: id, workspaceId: r.workspaceId, revision: rev.number };
  }, { timeout: 30_000 });
}

/**
 * Undo an approval right after it (the editor's "Approved · Undo" toast): rolls the target back to
 * just before the approval revision and puts the proposal back to pending. A proposal that made a
 * new design archives that design instead (nothing is deleted). Only while nothing else has changed
 * the target since; otherwise roll back from History. Measurement proposals are rolled back from History.
 */
export async function undoApproval(id: number) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM proposals WHERE id = ${id} FOR UPDATE`;
    const p = await tx.proposal.findUnique({ where: { id } });
    if (!p) throw new ApiError(404, 'proposal_not_found', `Proposal ${id} not found`);
    if (p.status !== 'approved') throw new ApiError(409, 'not_approved', `Proposal ${id} is ${p.status}`);
    if (p.kind === 'measurements') throw new ApiError(409, 'not_undoable', 'Measurement proposals are rolled back from History');
    if (!p.decidedAt || Date.now() - p.decidedAt.getTime() > 10 * 60_000) throw new ApiError(409, 'too_late', 'Undo is only offered right after approving. Roll back from History instead.');
    const rev = await tx.revision.findFirst({ where: { proposalId: id, kind: 'proposal' }, orderBy: { id: 'desc' } });
    if (!rev) throw new ApiError(409, 'not_undoable', 'No revision found for this approval');
    const latest = await tx.revision.findFirst({ where: { houseId: rev.houseId, scope: rev.scope }, orderBy: { number: 'desc' } });
    if (latest?.id !== rev.id) throw new ApiError(409, 'stale', 'Something changed after the approval. Roll back from History instead.');
    const made = rev.workspaceId != null ? await tx.workspace.findFirst({ where: { id: rev.workspaceId, sourceProposalId: id } }) : null;
    let result: { rolledBackTo?: number; archivedWorkspaceId?: number };
    if (made) {
      await tx.workspace.update({ where: { id: made.id }, data: { archivedAt: new Date(), sourceProposalId: null } });
      result = { archivedWorkspaceId: made.id };
    } else if (rev.workspaceId == null) {
      await rollbackCurrent(tx, rev.houseId, rev.number - 1, `Undid approval of #${id}`);
      result = { rolledBackTo: rev.number - 1 };
    } else {
      await rollbackWorkspace(tx, rev.workspaceId, rev.number - 1, `Undid approval of #${id}`);
      result = { rolledBackTo: rev.number - 1 };
    }
    await tx.proposal.update({ where: { id }, data: { status: 'pending', decidedAt: null, decisionNote: null, ...(made ? { targetWorkspaceId: null } : {}) } });
    return { proposalId: id, status: 'pending' as const, workspaceId: rev.workspaceId, ...result };
  }, { timeout: 30_000 });
}

export async function rejectProposal(id: number, note?: string) {
  const p = await prisma.proposal.findUnique({ where: { id } });
  if (!p) throw new ApiError(404, 'proposal_not_found', `Proposal ${id} not found`);
  if (p.status !== 'pending') throw new ApiError(409, 'not_pending', `Proposal ${id} is already ${p.status}`);
  await prisma.proposal.update({ where: { id }, data: { status: 'rejected', decidedAt: new Date(), decisionNote: note?.slice(0, 1000) } });
  return { proposalId: id, status: 'rejected' as const };
}

/** Which scope owns a structure entity: null for Current, or the draft room's workspace. */
async function measurementScope(tx: Tx, entityType: string, entityId: number): Promise<number | null> {
  const roomId = entityType === 'room' ? entityId
    : entityType === 'wall' ? (await tx.wall.findUniqueOrThrow({ where: { id: entityId } })).roomId
    : (await tx.wall.findUniqueOrThrow({ where: { id: (await tx.opening.findUniqueOrThrow({ where: { id: entityId } })).wallId } })).roomId;
  return (await tx.room.findUniqueOrThrow({ where: { id: roomId } })).draftWorkspaceId;
}

const STYLE_FIELDS = ['wallColorName', 'wallColor', 'trimColorName', 'trimColor', 'floorColorName', 'floorColor', 'deviceColorName', 'deviceColor'] as const;

/**
 * "Make this Current's furniture": a pending proposal (Michael approves it in Proposals) that sets
 * Current's furniture and colors, in the Current rooms this workspace links, to what the workspace
 * has. Pieces marked existing or keep are copied (with template parameters and 3D models); pieces
 * marked new, replace or remove are design ideas and are left out. Current's old pieces in those
 * rooms are removed. The workspace itself is not changed.
 */
async function currentPlan(workspaceId: number) {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  const links = await prisma.workspaceRoom.findMany({ where: { workspaceId }, include: { room: { select: { id: true, label: true, draftWorkspaceId: true } } } });
  const rooms = links.map((l) => l.room).filter((r) => r.draftWorkspaceId == null);
  if (!rooms.length) throw new ApiError(409, 'no_current_rooms', 'This workspace has no Current rooms');
  const roomIds = rooms.map((r) => r.id);
  const [pls, oldPls, styles, oldStyles] = await Promise.all([
    prisma.placement.findMany({ where: { workspaceId, roomId: { in: roomIds } }, orderBy: { id: 'asc' }, include: { params: { orderBy: { id: 'asc' } }, item: { select: { name: true } } } }),
    prisma.placement.findMany({ where: { workspaceId: null, roomId: { in: roomIds } }, orderBy: { id: 'asc' }, include: { params: true } }),
    prisma.roomStyle.findMany({ where: { workspaceId, roomId: { in: roomIds } } }),
    prisma.roomStyle.findMany({ where: { workspaceId: null, roomId: { in: roomIds } } }),
  ]);
  const keep = pls.filter((p) => p.action === 'existing' || p.action === 'keep');
  const skipped = pls.filter((p) => !keep.includes(p));
  const changes: any[] = [];
  // Already the same pieces in Current (same item, spot, turn, template, parameters, model)? Then leave them.
  const sig = (p: { roomId: number; itemId: number; xIn: number; yIn: number; rotationDeg: number; templateId: number | null; modelId: number | null; notes?: string | null; params?: { key: string; value: string }[] }) =>
    JSON.stringify([p.roomId, p.itemId, p.xIn, p.yIn, p.rotationDeg, p.templateId, p.modelId, p.notes ?? null, (p.params ?? []).map((x) => [x.key, x.value]).sort()]);
  const same = keep.length === oldPls.length && JSON.stringify(keep.map(sig).sort()) === JSON.stringify(oldPls.map(sig).sort());
  if (!same) for (const p of oldPls) changes.push({ op: 'delete', entityType: 'placement', entityId: p.id });
  if (!same) keep.forEach((p, i) => {
    const fields: Record<string, any> = { roomId: p.roomId, itemId: p.itemId, xIn: p.xIn, yIn: p.yIn, rotationDeg: p.rotationDeg, action: 'existing' };
    if (p.notes) fields.notes = p.notes;
    if (p.templateId != null) fields.templateId = p.templateId;
    if (p.modelId != null) fields.modelId = p.modelId;
    changes.push({ op: 'create', entityType: 'placement', tempRef: `p${i}`, fields });
    p.params.forEach((x, j) => changes.push({ op: 'create', entityType: 'placement_param', tempRef: `p${i}k${j}`, fields: { placementId: `$p${i}`, key: x.key, value: x.value } }));
  });
  for (const st of styles) {
    const old = oldStyles.find((o) => o.roomId === st.roomId);
    if (!old) {
      const fields: Record<string, any> = { roomId: st.roomId };
      for (const f of STYLE_FIELDS) if (st[f] != null) fields[f] = st[f];
      if (Object.keys(fields).length > 1) changes.push({ op: 'create', entityType: 'room_style', tempRef: `s${st.roomId}`, fields });
    } else for (const f of STYLE_FIELDS) if (st[f] !== old[f]) changes.push({ op: 'update', entityType: 'room_style', entityId: old.id, field: f, value: st[f] });
  }
  return { ws, rooms, roomIds, keep, skipped, oldPls, styles, oldStyles, changes };
}

/**
 * What "Save to Current" would do, for the editor's summary dialog: the pieces that go into Current,
 * the ideas that are left out, the rooms whose colors change, and pending proposals on the design.
 */
export async function saveToCurrentSummary(workspaceId: number) {
  const { ws, rooms, keep, skipped, oldPls, styles, oldStyles, changes } = await currentPlan(workspaceId);
  const items = await prisma.furnitureItem.findMany({ where: { id: { in: [...keep, ...skipped].map((p) => p.itemId) } }, select: { id: true, name: true } });
  const nm = (id: number) => items.find((i) => i.id === id)?.name ?? `item ${id}`;
  const pending = await prisma.proposal.findMany({ where: { status: 'pending', targetWorkspaceId: workspaceId }, select: { id: true, title: true }, orderBy: { id: 'asc' } });
  const house = await prisma.house.findFirst({ orderBy: { id: 'asc' } });
  const colorRooms = styles.filter((st) => {
    const old = oldStyles.find((o) => o.roomId === st.roomId);
    return STYLE_FIELDS.some((f) => st[f] != null && (!old || st[f] !== old[f]));
  }).map((st) => ({ roomId: st.roomId, label: rooms.find((r) => r.id === st.roomId)?.label ?? `room ${st.roomId}`, wallColor: st.wallColor, wallColorName: st.wallColorName, trimColor: st.trimColor, floorColor: st.floorColor }));
  return {
    workspaceId: ws.id, name: ws.name, revision: ws.revision, currentRevision: house?.currentRevision ?? 0,
    rooms: rooms.map((r) => ({ id: r.id, label: r.label })),
    goesIn: keep.map((p) => ({ placementId: p.id, name: nm(p.itemId), action: p.action, roomId: p.roomId })),
    leftOut: skipped.map((p) => ({ placementId: p.id, name: nm(p.itemId), action: p.action, roomId: p.roomId })),
    replacesCurrentPieces: oldPls.length, colors: colorRooms, pending,
    nothingToChange: changes.length === 0, changeCount: changes.length,
  };
}

/**
 * Save to Current in one step (Michael only): the summary dialog is his approval, so this files the
 * proposal and approves it at once. It is a normal Current revision, rolled back from History.
 * `revision` is the design revision the summary showed; a newer edit makes this a 409 stale.
 */
export async function saveToCurrent(workspaceId: number, revision: number) {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  if (ws.revision !== revision) throw new ApiError(409, 'stale', `"${ws.name}" changed since the summary (revision ${revision}, now ${ws.revision}). Look again.`);
  const filed = await proposeAsCurrent(workspaceId);
  try {
    const r = await approveProposal(filed.id, 'Saved to Current from the editor');
    return { proposalId: filed.id, currentRevision: r.revision };
  } catch (e) {
    // Don't leave a half-done save waiting in the Inbox.
    await rejectProposal(filed.id, `Save to Current did not go through: ${(e as Error).message}`.slice(0, 900)).catch(() => {});
    throw e;
  }
}

export async function proposeAsCurrent(workspaceId: number) {
  const { ws, rooms, roomIds, keep, skipped, oldPls, styles, changes } = await currentPlan(workspaceId);
  if (!changes.length) throw new ApiError(409, 'nothing_to_change', "Current already has this workspace's furniture and colors");
  if (changes.length > 200) throw new ApiError(400, 'too_many_changes', `That is ${changes.length} changes; a proposal holds 200. Split the rooms into separate workspaces.`);
  const names = rooms.map((r) => r.label).join(', ');
  const rationale = [
    `Michael asked to make the furniture and colors in "${ws.name}" (revision ${ws.revision}) what is in the house now.`,
    `${keep.length} piece(s) marked existing or keep are copied into Current${oldPls.length ? `, replacing Current's ${oldPls.length} piece(s) in ${names}` : ` for ${names}`}.`,
    styles.length ? `Colors for ${styles.length} room(s) are copied.` : 'No colors are set in this workspace.',
    skipped.length ? `Left out as design ideas (new, replace or remove): ${skipped.map((p) => p.item.name).join(', ')}.` : '',
    `The workspace itself is not changed. Approving makes a normal Current revision, which can be rolled back.`,
  ].filter(Boolean).join(' ');
  return createProposal({
    title: `Make "${ws.name}" Current's furniture`.slice(0, 200), rationale, current: true, roomIds,
    source: { kind: 'manual' }, changes,
    cost: { steps: [{ step: 'furniture', changes: 'Records what is already in the room; nothing to buy', lowUsd: 0, highUsd: 0 }] },
  }, { actor: 'michael' });
}
