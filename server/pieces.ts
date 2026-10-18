/**
 * Change lists for "put these templated pieces in the room" (lights, wall decor, soft goods, furniture)
 * and "color or finish these walls", for the MCP tools. Each piece becomes a furniture_item (with its
 * price), a placement drawn by the template, and its parameter values. A wall piece can be given as
 * {wallId, offsetIn} and is positioned against that wall, facing into the room.
 */
import { z } from 'zod';
import { prisma } from './db.js';
import { ApiError } from './util.js';
import { checkParam, derivedSize, templateBySlug } from './templates.js';
import { poseOnWall } from './mounting.js';
import { changeSchema } from './proposals.js';

const val = z.union([z.string(), z.number(), z.boolean()]);
export const pieceSchema = z.object({
  template: z.string().max(40).describe('Template slug from list_templates, e.g. "pendant", "framed_art", "curtains"'),
  roomId: z.number().int(),
  name: z.string().min(1).max(160).optional().describe('What it is, e.g. "Woven rattan pendant, 18in". Defaults to the template name'),
  params: z.record(z.string(), val).default({}).describe('Template parameter values (others use the defaults)'),
  xIn: z.number().int().optional(), yIn: z.number().int().optional(), rotationDeg: z.number().int().min(0).max(359).optional(),
  wall: z.object({ wallId: z.number().int(), offsetIn: z.number().min(0).describe('Distance along the wall from its start point to the piece center') }).optional()
    .describe('Hang it on this wall instead of giving xIn/yIn/rotationDeg (wall-mounted templates: art, mirrors, sconces, curtains, paneling, TV)'),
  wIn: z.number().int().min(1).max(2000).optional(), dIn: z.number().int().min(1).max(2000).optional(), hIn: z.number().int().min(0).max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  priceUsd: z.number().min(0).max(1_000_000).optional().describe('Price of this piece; without it the template\'s typical range is counted'),
  url: z.string().url().max(1000).optional(), notes: z.string().max(1000).optional(),
  action: z.enum(['new', 'existing', 'keep']).default('new'),
  replacesPlacementId: z.number().int().optional().describe('An existing placement this replaces (e.g. a pendant replacing the ceiling fan); mark that one "replace" separately'),
});
export type Piece = z.infer<typeof pieceSchema>;

export const wallFinishSchema = z.object({
  wallId: z.number().int(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), colorName: z.string().max(60).optional(),
  finish: z.enum(['paint', 'limewash']).optional(),
  notes: z.string().max(500).optional(),
  clear: z.boolean().optional().describe('Remove this wall\'s own color (it goes back to the room\'s wall color)'),
});

export const extraChanges = z.array(changeSchema).max(150).optional().describe('More changes in the same proposal (same format as create_proposal), e.g. room colors');

export async function pieceOps(pieces: Piece[], prefix = 'pc') {
  const ops: any[] = [];
  const templates = await prisma.furnitureTemplate.findMany({ select: { id: true, slug: true } });
  for (const [i, pc] of pieces.entries()) {
    const def = templateBySlug.get(pc.template), row = templates.find((t) => t.slug === pc.template);
    if (!def || !row) throw new ApiError(400, 'unknown_template', `Unknown template "${pc.template}". See list_templates.`);
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(pc.params)) params[k] = checkParam(def.slug, k, v);
    const size = derivedSize(def.slug, { ...Object.fromEntries(def.params.map((p) => [p.key, p.default])), ...params });
    const wIn = pc.wIn ?? size?.wIn ?? def.w, dIn = pc.dIn ?? def.d, hIn = pc.hIn ?? size?.hIn ?? Math.max(1, def.h);
    let pose = { xIn: pc.xIn, yIn: pc.yIn, rotationDeg: pc.rotationDeg ?? 0 };
    if (pc.wall) {
      const walls = await prisma.wall.findMany({ where: { roomId: pc.roomId } });
      pose = poseOnWall(walls, pc.wall.wallId, pc.wall.offsetIn, dIn);
    }
    if (pose.xIn == null || pose.yIn == null) throw new ApiError(400, 'missing_fields', `Piece ${i + 1} (${pc.template}): give xIn and yIn, or wall {wallId, offsetIn}`);
    const ref = `${prefix}${i}`;
    const item: Record<string, unknown> = { kind: def.kind, name: pc.name ?? def.name, wIn, dIn, hIn, status: pc.action === 'new' ? 'idea' : 'existing' };
    if (pc.color) item.color = pc.color.toLowerCase();
    if (pc.priceUsd != null) item.priceCents = Math.round(pc.priceUsd * 100);
    if (pc.url) item.url = pc.url;
    if (pc.notes) item.notes = pc.notes;
    ops.push({ op: 'create', entityType: 'furniture_item', tempRef: `${ref}i`, fields: item });
    const pl: Record<string, unknown> = { roomId: pc.roomId, itemId: `$${ref}i`, xIn: pose.xIn, yIn: pose.yIn, rotationDeg: pose.rotationDeg, action: pc.action, templateId: row.id };
    if (pc.replacesPlacementId != null) pl.replacesPlacementId = pc.replacesPlacementId;
    ops.push({ op: 'create', entityType: 'placement', tempRef: `${ref}p`, fields: pl });
    for (const [k, v] of Object.entries(params)) ops.push({ op: 'create', entityType: 'placement_param', fields: { placementId: `$${ref}p`, key: k, value: v } });
  }
  return ops;
}

/** Wall color/finish ops against the styles that exist in `workspaceId` (null = Current). */
export async function wallFinishOps(workspaceId: number | null, walls: z.infer<typeof wallFinishSchema>[]) {
  const ops: any[] = [];
  for (const [i, w] of walls.entries()) {
    const old = await prisma.wallStyle.findFirst({ where: { workspaceId, wallId: w.wallId } });
    if (w.clear) { if (old) ops.push({ op: 'delete', entityType: 'wall_style', entityId: old.id }); continue; }
    const fields: Record<string, string> = {};
    if (w.color) fields.color = w.color.toLowerCase();
    if (w.colorName) fields.colorName = w.colorName;
    if (w.finish) fields.finish = w.finish;
    if (w.notes) fields.notes = w.notes;
    if (!Object.keys(fields).length) throw new ApiError(400, 'missing_fields', `Wall ${w.wallId}: give color, colorName, finish or clear`);
    if (old) for (const [field, value] of Object.entries(fields)) { if ((old as any)[field] !== value) ops.push({ op: 'update', entityType: 'wall_style', entityId: old.id, field, value }); }
    else ops.push({ op: 'create', entityType: 'wall_style', tempRef: `wall${i}`, fields: { wallId: w.wallId, finish: 'paint', ...fields } });
  }
  return ops;
}
