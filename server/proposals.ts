/**
 * Proposals (change requests). Agents and inspiration create them; only Michael approves or rejects.
 * Approving applies the field-level changes as a new revision of the target workspace (or of a new
 * workspace copied from the base). Rejecting changes nothing and keeps the proposal for the record.
 */
import { z } from 'zod';
import type { Actor, Prisma } from '@prisma/client';
import { ApiError } from './util.js';
import { coerce, def, delegate, fieldSpec, ser, type Tx } from './entities.js';
import { applyOps, commitRevision, lockWorkspace, type Op } from './changes.js';
import { copyWorkspace, getWorkspaceView } from './workspaces.js';
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
  workspaceId: z.number().int().optional().describe('Target workspace. Omit and pass newWorkspace to propose a new design.'),
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
async function applyProposal(tx: Tx, p: { id: number; targetWorkspaceId: number | null; baseWorkspaceId: number | null; newWorkspaceName: string | null; createdBy: Actor }, ops: Op[], forReal: boolean) {
  let workspaceId: number;
  let idMap: Map<string, number> | undefined;
  if (p.targetWorkspaceId != null) {
    workspaceId = (await lockWorkspace(tx, p.targetWorkspaceId)).id;
  } else {
    if (p.baseWorkspaceId == null) throw new ApiError(409, 'no_base', 'The workspace this proposal copies from no longer exists');
    const copy = await copyWorkspace(tx, p.baseWorkspaceId, p.newWorkspaceName || 'New design', p.createdBy, forReal ? p.id : undefined);
    workspaceId = copy.workspace.id;
    idMap = copy.idMap;
  }
  const result = await applyOps(tx, ops, { workspaceId, mode: 'proposal', checkBefore: true, idMap });
  return { workspaceId, ...result };
}

export async function createProposal(input: ProposalInput, by: { actor: Actor; agentKeyId?: number }) {
  const p = proposalSchema.parse(input);
  if ((p.workspaceId == null) === (p.newWorkspace == null)) throw new ApiError(400, 'target_required', 'Pass exactly one of workspaceId or newWorkspace');
  const sourceWsId = p.workspaceId ?? p.newWorkspace!.copyFromWorkspaceId;
  const sourceWs = await prisma.workspace.findUnique({ where: { id: sourceWsId } });
  if (!sourceWs) throw new ApiError(404, 'workspace_not_found', `Workspace ${sourceWsId} not found`);
  for (const s of p.cost.steps) if (s.highUsd < s.lowUsd) throw new ApiError(400, 'invalid_cost', `Cost step "${s.changes}": high is below low`);

  // Rooms must be in the workspace.
  const view = await getWorkspaceView(prisma, sourceWsId);
  const roomIds = new Set(view.rooms.map((r) => r.id));
  const badRoom = p.roomIds.find((r) => !roomIds.has(r));
  if (badRoom != null) throw new ApiError(400, 'room_not_in_workspace', `Room ${badRoom} isn't in workspace ${sourceWsId}. Rooms: ${view.rooms.map((r) => `${r.id} ${r.label}`).join(', ')}`);

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
  await dryRun((tx) => applyProposal(tx, { id: 0, targetWorkspaceId: p.workspaceId ?? null, baseWorkspaceId: p.newWorkspace?.copyFromWorkspaceId ?? null, newWorkspaceName: p.newWorkspace?.name ?? null, createdBy: by.actor }, ops, false));

  const photoIds = [...new Set(p.photoIds ?? [])];
  if (photoIds.length) {
    const found = await prisma.scanPhoto.count({ where: { id: { in: photoIds } } });
    if (found !== photoIds.length) throw new ApiError(400, 'photo_not_found', 'One or more photoIds do not exist (see list_room_photos)');
  }

  const cents = (usd: number) => Math.round(usd * 100);
  const created = await prisma.proposal.create({
    data: {
      houseId: sourceWs.houseId, createdBy: by.actor, agentKeyId: by.agentKeyId ?? null,
      sourceKind: p.source.kind, sourceUrl: p.source.url, sourceImageUrl: p.source.imageUrl,
      targetWorkspaceId: p.workspaceId ?? null, newWorkspaceName: p.newWorkspace?.name ?? null, baseWorkspaceId: p.newWorkspace?.copyFromWorkspaceId ?? null,
      title: p.title, rationale: p.rationale, baseRevision: sourceWs.revision,
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
    target: p.kind === 'measurements' ? { kind: 'current' as const, workspace: null }
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

export async function listProposals(filter: { status?: 'pending' | 'approved' | 'rejected'; workspaceId?: number; limit?: number } = {}) {
  const rows = await prisma.proposal.findMany({
    where: {
      status: filter.status,
      ...(filter.workspaceId != null ? { OR: [{ targetWorkspaceId: filter.workspaceId }, { baseWorkspaceId: filter.workspaceId }] } : {}),
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
    const view = await getWorkspaceView(tx, r.workspaceId);
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
      workspaceId: r.workspaceId, kind: 'proposal', actor: p.createdBy, agentKeyId: p.agentKeyId, proposalId: p.id, changes: r.changes,
      note: `Approved by Michael: #${p.id} ${p.title}${note ? ` (${note})` : ''}`,
    });
    await tx.proposal.update({ where: { id }, data: { status: 'approved', decidedAt: new Date(), decisionNote: note?.slice(0, 1000), targetWorkspaceId: r.workspaceId } });
    return { proposalId: id, workspaceId: r.workspaceId, revision: rev.number };
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
