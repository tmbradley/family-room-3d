/**
 * Room scans from the App Clip.
 *
 *  1. parseCapturedRoom(): Apple RoomPlan `CapturedRoom` (JSONEncoder output) -> plan in whole inches.
 *  2. createScanImport(): stores the parsed scan relationally (scan_import_data) for review. Nothing
 *     in the design changes.
 *  3. promoteScanImport(): Michael-only. Applies the scan to Current as ONE revision through the
 *     change engine (revision_changes rows, so it can be rolled back), matching scanned walls and
 *     openings to existing ones so ids and pins survive. Every scanned value is recorded as a
 *     measurement row (source "scan"); pinned values always win and are never overwritten.
 *
 * RoomPlan format (CapturedRoom is Codable): walls/doors/windows/openings are Surfaces and
 * objects are Objects, each with
 *   - category: keyed enum, e.g. {"wall":{}}, {"door":{"isOpen":false}}, {"sofa":{}}
 *   - dimensions: simd_float3 [x, y, z] in meters. Surfaces: [width/length, height, 0].
 *     Objects: [width, height, depth]. Height is always index 1 (y is up).
 *   - transform: simd_float4x4, 16 floats, column-major. Column 0 = local x axis, column 3 = position.
 *   - parentIdentifier (iOS 17+): the wall a door/window/opening sits in.
 */
import { z } from 'zod';
import { prisma } from './db.js';
import { ApiError } from './util.js';
import { applyOps, commitRevision, isPinned, lockHouse, type Op } from './changes.js';
import type { Tx } from './entities.js';
import { listPhotos } from './photos.js';
import { matchTemplate, templateBySlug } from './templates.js';
import { createBlankWorkspace } from './workspaces.js';

// ---------------------------------------------------------------------------
// Input validation (only the parts we use; everything else is passed through and ignored)
// ---------------------------------------------------------------------------
const num = z.number().finite();
const surface = z.object({
  identifier: z.string().min(1).max(100),
  parentIdentifier: z.string().max(100).nullable().optional(),
  category: z.union([z.string(), z.record(z.string(), z.any())]),
  dimensions: z.array(num).length(3),
  transform: z.array(num).length(16),
}).passthrough();
const object = surface;
export const capturedRoomSchema = z.object({
  walls: z.array(surface).min(1).max(300),
  doors: z.array(surface).max(300).default([]),
  windows: z.array(surface).max(300).default([]),
  openings: z.array(surface).max(300).default([]),
  floors: z.array(surface).max(50).optional(),
  objects: z.array(object).max(1000).default([]),
}).passthrough();
export type CapturedRoom = z.input<typeof capturedRoomSchema>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
const M_TO_IN = 39.37007874;
const toIn = (m: number) => Math.round(m * M_TO_IN);
const categoryOf = (c: unknown) => (typeof c === 'string' ? c : c && typeof c === 'object' ? Object.keys(c)[0] ?? 'unknown' : 'unknown');

export type ParsedWall = { key: string; startXIn: number; startYIn: number; endXIn: number; endYIn: number; heightIn: number; lengthIn: number };
export type ParsedOpening = { key: string; wallKey: string; type: 'window' | 'door' | 'open_span'; offsetIn: number; widthIn: number; sillIn: number; headIn: number };
export type ParsedObject = { key: string; kind: string; xIn: number; yIn: number; rotationDeg: number; widthIn: number; depthIn: number; heightIn: number; label?: string };
export type ParsedScan = {
  widthIn: number; depthIn: number; ceilingIn: number;
  /** How far the scan was rotated (degrees) so its walls line up with the plan axes. */
  alignedByDeg: number;
  walls: ParsedWall[]; openings: ParsedOpening[]; objects: ParsedObject[];
};

type P = { x: number; y: number };

/**
 * Plan coordinates: x = world X, y = -world Z, in inches: the room seen from above, not mirrored
 * (RoomPlan's world is right-handed with y up, and the editor draws plan y toward world -Z).
 * Rotated so the dominant wall direction lines up with the x axis and shifted so the walls start
 * at (0, 0). Scans parsed before PLAN_FRAME 2 used y = +world Z, which drew a mirror image.
 */
export const PLAN_FRAME = 2;
export function parseCapturedRoom(input: unknown): ParsedScan {
  const parsed = capturedRoomSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'invalid_scan', `Not a RoomPlan CapturedRoom: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const room = parsed.data;

  // Walls in world meters.
  const rawWalls = room.walls.map((w) => {
    const t = w.transform;
    let dx = t[0], dz = -t[2];
    const n = Math.hypot(dx, dz) || 1; dx /= n; dz /= n;
    const len = w.dimensions[0], h = w.dimensions[1];
    const c = { x: t[12], y: -t[14] };
    return { key: w.identifier, a: { x: c.x - (dx * len) / 2, y: c.y - (dz * len) / 2 }, b: { x: c.x + (dx * len) / 2, y: c.y + (dz * len) / 2 }, len, h, cy: t[13] };
  });

  // Dominant direction (walls are mostly at right angles): average of 4*angle, weighted by length.
  let s = 0, co = 0;
  for (const w of rawWalls) { const a = Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x); s += Math.sin(4 * a) * w.len; co += Math.cos(4 * a) * w.len; }
  const theta = Math.atan2(s, co) / 4;
  const rot = (p: P): P => ({ x: p.x * Math.cos(theta) + p.y * Math.sin(theta), y: -p.x * Math.sin(theta) + p.y * Math.cos(theta) });
  const rotated = rawWalls.map((w) => ({ ...w, a: rot(w.a), b: rot(w.b) }));
  const minX = Math.min(...rotated.flatMap((w) => [w.a.x, w.b.x]));
  const minY = Math.min(...rotated.flatMap((w) => [w.a.y, w.b.y]));
  const plan = (p: P): P => { const r = rot(p); return { x: (r.x - minX) * M_TO_IN, y: (r.y - minY) * M_TO_IN }; };
  const shift = (p: P): P => ({ x: (p.x - minX) * M_TO_IN, y: (p.y - minY) * M_TO_IN });

  // Floor height (world y): the floor surface if present, otherwise the lowest wall bottom.
  const floorY = room.floors?.length ? Math.min(...room.floors.map((f) => f.transform[13])) : Math.min(...rawWalls.map((w) => w.cy - w.h / 2));
  const ceilingIn = toIn(Math.max(...rawWalls.map((w) => w.cy + w.h / 2)) - floorY);

  const walls: ParsedWall[] = rotated.map((w) => {
    const a = shift(w.a), b = shift(w.b);
    return { key: w.key, startXIn: Math.round(a.x), startYIn: Math.round(a.y), endXIn: Math.round(b.x), endYIn: Math.round(b.y), heightIn: toIn(w.h), lengthIn: toIn(w.len) };
  });
  const wallByKey = new Map(walls.map((w) => [w.key, w]));

  const segDist = (p: P, w: ParsedWall) => {
    const ax = w.startXIn, ay = w.startYIn, bx = w.endXIn, by = w.endYIn;
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / L2));
    return Math.hypot(p.x - (ax + t * (bx - ax)), p.y - (ay + t * (by - ay)));
  };

  const surfaces = [
    ...room.doors.map((d) => ({ d, type: 'door' as const })),
    ...room.windows.map((d) => ({ d, type: 'window' as const })),
    ...room.openings.map((d) => ({ d, type: 'open_span' as const })),
  ];
  const openings: ParsedOpening[] = [];
  for (const { d, type } of surfaces) {
    const t = d.transform;
    const c = plan({ x: t[12], y: -t[14] });
    const wall = (d.parentIdentifier && wallByKey.get(d.parentIdentifier)) || [...walls].sort((p, q) => segDist(c, p) - segDist(c, q))[0];
    const len = Math.hypot(wall.endXIn - wall.startXIn, wall.endYIn - wall.startYIn) || 1;
    const along = ((c.x - wall.startXIn) * (wall.endXIn - wall.startXIn) + (c.y - wall.startYIn) * (wall.endYIn - wall.startYIn)) / len;
    const widthIn = toIn(d.dimensions[0]), heightIn = toIn(d.dimensions[1]);
    const offsetIn = Math.max(0, Math.min(Math.round(along - widthIn / 2), Math.max(0, Math.round(len) - widthIn)));
    const bottom = type === 'window' ? Math.max(0, toIn(t[13] - d.dimensions[1] / 2 - floorY)) : 0;
    openings.push({ key: d.identifier, wallKey: wall.key, type, offsetIn, widthIn, sillIn: bottom, headIn: bottom + heightIn });
  }

  const objects: ParsedObject[] = room.objects.map((o) => {
    const t = o.transform;
    const c = plan({ x: t[12], y: -t[14] });
    const yaw = (Math.atan2(-t[2], t[0]) - theta) * (180 / Math.PI); // local x direction in the plan
    return {
      key: o.identifier, kind: categoryOf(o.category), xIn: Math.round(c.x), yIn: Math.round(c.y),
      rotationDeg: ((Math.round(yaw) % 360) + 360) % 360,
      widthIn: toIn(o.dimensions[0]), heightIn: toIn(o.dimensions[1]), depthIn: toIn(o.dimensions[2]),
    };
  });

  const xs = walls.flatMap((w) => [w.startXIn, w.endXIn]), ys = walls.flatMap((w) => [w.startYIn, w.endYIn]);
  return {
    widthIn: Math.max(...xs) - Math.min(...xs), depthIn: Math.max(...ys) - Math.min(...ys), ceilingIn,
    alignedByDeg: Math.round((theta * 180) / Math.PI * 10) / 10 + 0,
    walls, openings, objects,
  };
}

// ---------------------------------------------------------------------------
// Scan imports (review queue)
// ---------------------------------------------------------------------------
type Row = { entityType: string; entityIndex: number; field: string; value: string };

function toRows(p: ParsedScan, label: string): Row[] {
  const rows: Row[] = [];
  const put = (entityType: string, entityIndex: number, obj: Record<string, unknown>) => {
    for (const [field, v] of Object.entries(obj)) rows.push({ entityType, entityIndex, field, value: String(v) });
  };
  put('room', 0, { label, widthIn: p.widthIn, depthIn: p.depthIn, ceilingIn: p.ceilingIn, alignedByDeg: p.alignedByDeg });
  p.walls.forEach((w, i) => put('wall', i, w));
  p.openings.forEach((o, i) => put('opening', i, o));
  p.objects.forEach((o, i) => put('object', i, o));
  return rows;
}

function fromRows(rows: Row[]) {
  const by: Record<string, Record<number, Record<string, string>>> = {};
  for (const r of rows) ((by[r.entityType] ??= {})[r.entityIndex] ??= {})[r.field] = r.value;
  const list = (t: string) => Object.entries(by[t] ?? {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => v);
  const n = (v: string | undefined) => Number(v);
  const room = by.room?.[0] ?? {};
  return {
    label: room.label ?? 'Scanned room',
    scan: {
      widthIn: n(room.widthIn), depthIn: n(room.depthIn), ceilingIn: n(room.ceilingIn), alignedByDeg: n(room.alignedByDeg),
      walls: list('wall').map((w) => ({ key: w.key, startXIn: n(w.startXIn), startYIn: n(w.startYIn), endXIn: n(w.endXIn), endYIn: n(w.endYIn), heightIn: n(w.heightIn), lengthIn: n(w.lengthIn) })),
      openings: list('opening').map((o) => ({ key: o.key, wallKey: o.wallKey, type: o.type as ParsedOpening['type'], offsetIn: n(o.offsetIn), widthIn: n(o.widthIn), sillIn: n(o.sillIn), headIn: n(o.headIn) })),
      objects: list('object').map((o) => ({ key: o.key, kind: o.kind, xIn: n(o.xIn), yIn: n(o.yIn), rotationDeg: n(o.rotationDeg), widthIn: n(o.widthIn), depthIn: n(o.depthIn), heightIn: n(o.heightIn), ...(o.label ? { label: o.label } : {}) })),
    } as ParsedScan,
  };
}

/** Short labels from the phone (on-device model), keyed by RoomPlan object identifier. */
const cleanLabel = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);

export async function createScanImport(p: { houseId: number; uploadId: number; roomplanData: unknown; label: string; roomId: number | null; tokenId?: number; objectLabels?: Record<string, string> }) {
  const parsed = parseCapturedRoom(p.roomplanData);
  for (const o of parsed.objects) { const l = cleanLabel(p.objectLabels?.[o.key]); if (l) o.label = l; }
  return prisma.$transaction(async (tx) => {
    if (await tx.scanImport.findUnique({ where: { uploadId: p.uploadId } })) throw new ApiError(409, 'already_imported', 'This upload was already imported');
    const si = await tx.scanImport.create({ data: { houseId: p.houseId, roomId: p.roomId, uploadId: p.uploadId, label: p.label.slice(0, 120), status: 'pending', planFrame: PLAN_FRAME } });
    await tx.scanImportData.createMany({ data: toRows(parsed, p.label).map((r) => ({ ...r, value: r.value.slice(0, 1000), scanImportId: si.id })) });
    await tx.upload.update({ where: { id: p.uploadId }, data: { status: 'imported', scanImportId: si.id } });
    // Everything else uploaded with this code belongs to the scan too (USDZ, photos).
    if (p.tokenId != null) {
      await tx.upload.updateMany({ where: { tokenId: p.tokenId, id: { not: p.uploadId }, scanImportId: null, status: 'uploaded' }, data: { scanImportId: si.id } });
      await tx.scanPhoto.updateMany({ where: { upload: { is: { tokenId: p.tokenId } }, scanImportId: null }, data: { scanImportId: si.id, roomId: p.roomId } });
    }
    return { id: si.id, status: si.status, label: si.label, walls: parsed.walls.length, openings: parsed.openings.length, objects: parsed.objects.length };
  });
}

/** A room view (same shape as GET /api/workspaces/:id rooms) so the editor can draw the scan. */
function previewRoom(label: string, s: ParsedScan) {
  const byWall = new Map<string, ParsedOpening[]>();
  for (const o of s.openings) byWall.set(o.wallKey, [...(byWall.get(o.wallKey) ?? []), o]);
  let oid = 0;
  return {
    id: -1, slug: 'scan', label, draftWorkspaceId: null, originXIn: 0, originYIn: 0, rotationDeg: 0, ceilingIn: s.ceilingIn,
    floor: { material: null, finish: null, color: null, keep: false }, wallColor: { name: null, color: null }, trimColor: { name: null, color: null },
    measurementStatus: 'scan', measurements: {},
    walls: s.walls.map((w, i) => ({
      id: -(i + 1), roomId: -1, label: null, startXIn: w.startXIn, startYIn: w.startYIn, endXIn: w.endXIn, endYIn: w.endYIn,
      heightIn: w.heightIn, thicknessIn: 5, isOpen: false, openTo: null, notes: null, measurementStatus: 'scan', measurements: {},
      openings: (byWall.get(w.key) ?? []).map((o) => ({
        id: -(++oid), wallId: -(i + 1), label: null, type: o.type, offsetIn: o.offsetIn, widthIn: o.widthIn, sillIn: o.sillIn, headIn: o.headIn,
        flush: false, treatment: null, notes: null, measurementStatus: 'scan', measurements: {},
      })),
    })),
    fixtures: [], furniture: [],
  };
}

export async function getScanImport(id: number) {
  const si = await prisma.scanImport.findUnique({
    where: { id },
    include: { room: { select: { id: true, label: true, slug: true } }, data: true, files: { select: { id: true, kind: true, format: true, bytes: true, status: true } } },
  });
  if (!si) throw new ApiError(404, 'not_found', 'Scan import not found');
  const { label, scan } = fromRows(si.data);
  const { data: _rows, ...rest } = si;
  const objects = scan.objects.map((o) => ({ ...o, template: matchTemplate(o.kind, o.widthIn, o.depthIn, o.heightIn) }));
  const photos = await listPhotos({ scanImportId: si.id });
  return {
    ...rest, parsed: { ...scan, objects }, photos, canFurnish: await canFurnish(si.id),
    preview: { id: `scan:${si.id}`, name: `Scan #${si.id}: ${label}`, revision: null, units: 'in', rooms: [previewRoom(label, scan)] },
  };
}

export async function listScanImports(houseId: number, status?: 'pending' | 'promoted' | 'rejected') {
  const rows = await prisma.scanImport.findMany({
    where: { houseId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 50,
    include: { room: { select: { id: true, label: true } }, _count: { select: { data: true, files: true } } },
  });
  return rows.map((r) => ({ id: r.id, status: r.status, label: r.label, room: r.room, createdAt: r.createdAt, promotedAt: r.promotedAt, files: r._count.files }));
}

export async function rejectScanImport(id: number, notes?: string) {
  const r = await prisma.scanImport.updateMany({ where: { id, status: 'pending' }, data: { status: 'rejected', notes: notes ?? null } });
  if (!r.count) {
    if (!(await prisma.scanImport.findUnique({ where: { id } }))) throw new ApiError(404, 'not_found', 'Scan import not found');
    throw new ApiError(409, 'already_processed', 'This scan was already promoted or rejected');
  }
  return { id, status: 'rejected' as const };
}

// ---------------------------------------------------------------------------
// Promote to Current
// ---------------------------------------------------------------------------
const d2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
type WallGeom = { startXIn: number; startYIn: number; endXIn: number; endYIn: number };
/** Average endpoint distance between two walls, and whether the scan wall runs the other way. */
export function wallDistance(a: WallGeom, b: WallGeom) {
  const same = (d2(a.startXIn, a.startYIn, b.startXIn, b.startYIn) + d2(a.endXIn, a.endYIn, b.endXIn, b.endYIn)) / 2;
  const flip = (d2(a.startXIn, a.startYIn, b.endXIn, b.endYIn) + d2(a.endXIn, a.endYIn, b.startXIn, b.startYIn)) / 2;
  return flip < same ? { dist: flip, reversed: true } : { dist: same, reversed: false };
}
/** Walls closer than this (average endpoint distance) are treated as the same wall. */
export const WALL_MATCH_IN = 36;
/** Openings on the same wall whose centers are closer than this are the same opening. */
export const OPENING_MATCH_IN = 24;

/**
 * A rescan's frame is arbitrary up to a quarter turn (RoomPlan's world frame starts wherever the
 * phone was; the parser squares walls to the axes but can't know which way is "north"). Try the
 * four quarter turns, aligning bounding boxes, and keep the one whose walls land closest to the
 * existing walls.
 */
export function alignToRoom<T extends WallGeom>(scanWalls: T[], existing: WallGeom[]): { walls: T[]; quarterTurns: number } {
  if (!existing.length) return { walls: scanWalls, quarterTurns: 0 };
  const bbox = (ws: WallGeom[]) => {
    const xs = ws.flatMap((w) => [w.startXIn, w.endXIn]), ys = ws.flatMap((w) => [w.startYIn, w.endYIn]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const shift = (ws: T[], dx: number, dy: number) => ws.map((w) => ({ ...w, startXIn: w.startXIn + dx, startYIn: w.startYIn + dy, endXIn: w.endXIn + dx, endYIn: w.endYIn + dy }));
  const cost = (ws: WallGeom[]) => ws.reduce((a, w) => a + Math.min(120, ...existing.map((e) => wallDistance(e, w).dist)), 0);
  const target = bbox(existing);
  let best: { walls: T[]; cost: number; k: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const rot = (x: number, y: number): [number, number] => (k === 0 ? [x, y] : k === 1 ? [-y, x] : k === 2 ? [-x, -y] : [y, -x]);
    const turned = scanWalls.map((w) => {
      const [sx, sy] = rot(w.startXIn, w.startYIn), [ex, ey] = rot(w.endXIn, w.endYIn);
      return { ...w, startXIn: sx, startYIn: sy, endXIn: ex, endYIn: ey };
    });
    const b = bbox(turned);
    // A partial scan lines up with either the near or the far corner of the existing room.
    for (const [dx, dy] of [[target.x0 - b.x0, target.y0 - b.y0], [target.x1 - b.x1, target.y1 - b.y1], [target.x0 - b.x0, target.y1 - b.y1], [target.x1 - b.x1, target.y0 - b.y0]]) {
      const moved = shift(turned, dx, dy);
      const c = cost(moved);
      if (!best || c < best.cost) best = { walls: moved, cost: c, k };
    }
  }
  // Refine the translation with the median endpoint offset of matched walls (robust to one moved wall).
  const dxs: number[] = [], dys: number[] = [];
  for (const w of best!.walls) {
    let m: { e: WallGeom; dist: number; reversed: boolean } | null = null;
    for (const e of existing) { const d = wallDistance(e, w); if (d.dist <= WALL_MATCH_IN && (!m || d.dist < m.dist)) m = { e, ...d }; }
    if (!m) continue;
    const [sx, sy, ex, ey] = m.reversed ? [w.endXIn, w.endYIn, w.startXIn, w.startYIn] : [w.startXIn, w.startYIn, w.endXIn, w.endYIn];
    dxs.push(m.e.startXIn - sx, m.e.endXIn - ex); dys.push(m.e.startYIn - sy, m.e.endYIn - ey);
  }
  const median = (xs: number[]) => { if (!xs.length) return 0; const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  return { walls: shift(best!.walls, Math.round(median(dxs)), Math.round(median(dys))), quarterTurns: best!.k };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'room';

export async function promoteScanImport(id: number, actor: 'michael' = 'michael') {
  return prisma.$transaction((tx) => promoteIn(tx, id, actor), { timeout: 60_000 });
}

export async function promoteIn(tx: Tx, id: number, actor: 'michael') {
  const si = await tx.scanImport.findUnique({ where: { id }, include: { data: true } });
  if (!si) throw new ApiError(404, 'not_found', 'Scan import not found');
  await lockHouse(tx, si.houseId);
  const fresh = await tx.scanImport.findUniqueOrThrow({ where: { id } });
  if (fresh.status !== 'pending') throw new ApiError(409, 'already_processed', 'This scan was already promoted or rejected');
  const { label, scan } = fromRows(si.data);
  if (!scan.walls.length) throw new ApiError(400, 'invalid_scan', 'The scan has no walls');

  let room = si.roomId != null ? await tx.room.findUnique({ where: { id: si.roomId }, include: { walls: { include: { openings: true, fixtures: { select: { id: true } } } } } }) : null;
  if (room && room.draftWorkspaceId !== null) throw new ApiError(409, 'not_current', 'This scan targets a draft room; scans only promote into Current rooms');
  if (room && room.planFrame != null && room.planFrame !== si.planFrame)
    throw new ApiError(409, 'mirrored_room', `${room.label} was built from an older scan that drew it as a mirror image. Fix it first (Review panel: "Fix mirror image"), then promote this scan.`);

  const ops: Op[] = [];
  const kept: string[] = [];
  /** Scanned values to record as measurement rows: entity ref (id or $tempRef), field, value. */
  const scanned: { ref: number | string; entityType: string; field: string; valueIn: number }[] = [];
  const pinnedNow = async (entityType: string, entityId: number, field: string) => isPinned(tx, entityType, entityId, field);
  const setIfFree = async (entityType: string, entityId: number, field: string, value: number, current: number | null) => {
    scanned.push({ ref: entityId, entityType, field, valueIn: value });
    if (await pinnedNow(entityType, entityId, field)) { kept.push(`${entityType} ${entityId} ${field} (pinned)`); return; }
    if (current !== value) ops.push({ op: 'update', entityType, entityId, field, after: value });
  };
  const wallFields = ['startXIn', 'startYIn', 'endXIn', 'endYIn', 'heightIn'] as const;
  const openingFields = ['offsetIn', 'widthIn', 'sillIn', 'headIn'] as const;
  const createWall = (w: ParsedWall, i: number, roomRef: number | string) => {
    const ref = `wall${i}`;
    ops.push({ op: 'create', entityType: 'wall', tempRef: ref, fields: { roomId: roomRef, startXIn: w.startXIn, startYIn: w.startYIn, endXIn: w.endXIn, endYIn: w.endYIn, heightIn: w.heightIn, thicknessIn: 5, measurementStatus: 'scan' } });
    for (const f of wallFields) scanned.push({ ref: `$${ref}`, entityType: 'wall', field: f, valueIn: w[f] });
    return `$${ref}`;
  };
  const createOpening = (o: ParsedOpening, i: number, wallRef: number | string) => {
    const ref = `opening${i}`;
    ops.push({ op: 'create', entityType: 'opening', tempRef: ref, fields: { wallId: wallRef, type: o.type, offsetIn: o.offsetIn, widthIn: o.widthIn, sillIn: o.sillIn, headIn: o.headIn, measurementStatus: 'scan' } });
    for (const f of openingFields) scanned.push({ ref: `$${ref}`, entityType: 'opening', field: f, valueIn: o[f] });
  };
  const openingsByWall = new Map<string, { o: ParsedOpening; i: number }[]>();
  scan.openings.forEach((o, i) => openingsByWall.set(o.wallKey, [...(openingsByWall.get(o.wallKey) ?? []), { o, i }]));

  let created = false;
  if (!room) {
    // New Current room from this scan.
    const base = slugify(label);
    let slug = base, n = 2;
    while (await tx.room.findFirst({ where: { houseId: si.houseId, draftWorkspaceId: null, slug } })) slug = `${base}-${n++}`;
    ops.push({ op: 'create', entityType: 'room', tempRef: 'room', fields: { houseId: si.houseId, slug, label, ceilingIn: scan.ceilingIn, measurementStatus: 'scan', planFrame: si.planFrame } });
    scanned.push({ ref: '$room', entityType: 'room', field: 'ceilingIn', valueIn: scan.ceilingIn });
    created = true;
    scan.walls.forEach((w, i) => {
      const wref = createWall(w, i, '$room');
      for (const { o, i: oi } of openingsByWall.get(w.key) ?? []) createOpening(o, oi, wref);
    });
  } else {
    await setIfFree('room', room.id, 'ceilingIn', scan.ceilingIn, room.ceilingIn);
    if (room.measurementStatus !== 'scan') ops.push({ op: 'update', entityType: 'room', entityId: room.id, field: 'measurementStatus', after: 'scan' });

    // Put the scan in the existing room's frame, then greedily match nearest walls.
    const aligned = alignToRoom(scan.walls, room.walls.filter((w) => !w.isOpen));
    scan.walls = aligned.walls;
    const pairs: { si: number; wi: number; dist: number; reversed: boolean }[] = [];
    scan.walls.forEach((sw, si2) => room!.walls.forEach((ew, wi) => {
      if (ew.isOpen) return; // open edges are drawn by hand; scans don't produce them
      const m = wallDistance(ew, sw);
      if (m.dist <= WALL_MATCH_IN) pairs.push({ si: si2, wi, ...m });
    }));
    pairs.sort((a, b) => a.dist - b.dist);
    const usedS = new Set<number>(), usedW = new Set<number>();
    const matches: typeof pairs = [];
    for (const p of pairs) if (!usedS.has(p.si) && !usedW.has(p.wi)) { usedS.add(p.si); usedW.add(p.wi); matches.push(p); }

    for (const m of matches) {
      const ew = room.walls[m.wi];
      const raw = scan.walls[m.si];
      // Keep the existing wall's direction so its openings' offsets (measured from its start) stay meaningful.
      const sw = m.reversed ? { ...raw, startXIn: raw.endXIn, startYIn: raw.endYIn, endXIn: raw.startXIn, endYIn: raw.startYIn } : raw;
      for (const f of wallFields) await setIfFree('wall', ew.id, f, sw[f], ew[f]);
      if (ew.measurementStatus !== 'scan') ops.push({ op: 'update', entityType: 'wall', entityId: ew.id, field: 'measurementStatus', after: 'scan' });
      const len = raw.lengthIn;
      const scannedOpenings = (openingsByWall.get(raw.key) ?? []).map(({ o, i }) => ({ i, o: m.reversed ? { ...o, offsetIn: Math.max(0, len - o.offsetIn - o.widthIn) } : o }));
      // Match openings on this wall by type and center position.
      const op2: { s: number; e: number; dist: number }[] = [];
      scannedOpenings.forEach(({ o }, s) => ew.openings.forEach((eo, e) => {
        if (eo.type !== o.type) return;
        const dist = Math.abs(eo.offsetIn + eo.widthIn / 2 - (o.offsetIn + o.widthIn / 2));
        if (dist <= OPENING_MATCH_IN) op2.push({ s, e, dist });
      }));
      op2.sort((a, b) => a.dist - b.dist);
      const uS = new Set<number>(), uE = new Set<number>();
      for (const p of op2) {
        if (uS.has(p.s) || uE.has(p.e)) continue;
        uS.add(p.s); uE.add(p.e);
        const eo = ew.openings[p.e], o = scannedOpenings[p.s].o;
        for (const f of openingFields) await setIfFree('opening', eo.id, f, o[f], eo[f]);
        if (eo.measurementStatus !== 'scan') ops.push({ op: 'update', entityType: 'opening', entityId: eo.id, field: 'measurementStatus', after: 'scan' });
      }
      for (const [e, eo] of ew.openings.entries()) {
        if (uE.has(e)) continue;
        if (eo.type === 'fireplace') { kept.push(`opening ${eo.id} (fireplace; scans don't detect these)`); continue; }
        if (await anyPin(tx, 'opening', eo.id, openingFields)) { kept.push(`opening ${eo.id} (not in scan, but has pinned values)`); continue; }
        ops.push({ op: 'delete', entityType: 'opening', entityId: eo.id });
      }
      scannedOpenings.forEach(({ o, i }, s) => { if (!uS.has(s)) createOpening(o, i, ew.id); });
    }

    // Existing walls the scan didn't see: remove unless something pins them in place.
    for (const [wi, ew] of room.walls.entries()) {
      if (usedW.has(wi)) continue;
      if (ew.isOpen) { kept.push(`wall ${ew.id} (open edge)`); continue; }
      const pinnedOpening = await Promise.all(ew.openings.map((o) => anyPin(tx, 'opening', o.id, openingFields)));
      if (ew.fixtures.length || ew.openings.some((o) => o.type === 'fireplace') || pinnedOpening.some(Boolean) || (await anyPin(tx, 'wall', ew.id, wallFields))) {
        kept.push(`wall ${ew.id} (not in scan, but has pins, fixtures or a fireplace)`); continue;
      }
      for (const o of ew.openings) ops.push({ op: 'delete', entityType: 'opening', entityId: o.id });
      ops.push({ op: 'delete', entityType: 'wall', entityId: ew.id });
    }
    // New walls.
    scan.walls.forEach((w, i) => {
      if (usedS.has(i)) return;
      const wref = createWall(w, i, room!.id);
      for (const { o, i: oi } of openingsByWall.get(w.key) ?? []) createOpening(o, oi, wref);
    });
  }

  const { changes, refs } = await applyOps(tx, ops, { workspaceId: null, mode: 'rescan', trusted: true });
  const rev = await commitRevision(tx, {
    workspaceId: null, houseId: si.houseId, kind: 'rescan', actor, changes,
    note: [`Promoted scan #${si.id} (${label})`, kept.length ? `Kept: ${kept.join('; ')}` : ''].filter(Boolean).join('. '),
  });
  const resolveRef = (r: number | string) => (typeof r === 'number' ? r : refs[r.slice(1)]);
  await tx.measurement.createMany({
    data: scanned.map((m) => ({
      entityType: m.entityType, entityId: resolveRef(m.ref), field: m.field, valueIn: m.valueIn, source: 'scan' as const,
      isOverride: false, uploadId: si.uploadId, recordedBy: actor, note: `Scan #${si.id}`,
    })),
  });
  const roomId = room?.id ?? refs.room;
  await tx.scanImport.update({ where: { id }, data: { status: 'promoted', promotedAt: new Date(), promotedBy: actor, roomId } });
  await tx.scanPhoto.updateMany({ where: { scanImportId: id }, data: { roomId } });
  return { scanImportId: id, roomId, roomCreated: created, revision: rev.number, changeRows: changes.length, measurementsRecorded: scanned.length, kept };
}

async function anyPin(tx: Tx, entityType: string, entityId: number, fields: readonly string[]) {
  for (const f of fields) if (await isPinned(tx, entityType, entityId, f)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Furniture from a scan: RoomPlan objects -> closest templates, as placements in a new workspace.
// ---------------------------------------------------------------------------
/**
 * Only for a promoted scan that created its room (a rescan's objects are in its own frame, not the
 * room's), and only once the room is drawn the right way round.
 */
async function furnishCheck(id: number): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const si = await prisma.scanImport.findUnique({ where: { id }, include: { upload: { include: { token: true } }, room: true } });
  if (!si || si.status !== 'promoted' || !si.room || !si.upload.token?.newRoom)
    return { ok: false, code: 'cannot_furnish', message: 'Only a promoted scan that created its room can be furnished (rescans are in a different frame)' };
  if (si.room.planFrame === 1) return { ok: false, code: 'mirrored_room', message: `Fix the mirror image of ${si.room.label} first` };
  return { ok: true };
}
const canFurnish = async (id: number) => (await furnishCheck(id)).ok;

/** RoomPlan yaw (local x direction in the plan, counterclockwise) -> editor rotation (three.js rotation.y), squared to 90°. */
export const editorRotation = (yawDeg: number) => (((Math.round(yawDeg / 90) * 90) % 360) + 360) % 360;

/** Objects of a frame-1 (mirrored) scan, re-expressed in the corrected frame of its fixed room. */
export function unmirrorObjects(scan: { walls: { startYIn: number; endYIn: number }[]; objects: ParsedObject[] }) {
  const maxY = Math.max(...scan.walls.flatMap((w) => [w.startYIn, w.endYIn]));
  return scan.objects.map((o) => ({ ...o, yIn: maxY - o.yIn, rotationDeg: (360 - o.rotationDeg) % 360 }));
}

/**
 * Rooms built from a frame-1 scan are a mirror image (y flipped). Flip them back: wall endpoints and
 * fixture positions get y' = maxY - y (opening offsets along each wall stay valid), as one Current
 * revision that can be rolled back. Refused while anything would be left in the old frame.
 */
export async function fixMirroredRoom(roomId: number) {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({ where: { id: roomId }, include: { walls: true, fixtures: true } });
    if (!room || room.draftWorkspaceId !== null) throw new ApiError(404, 'room_not_found', 'Current room not found');
    await lockHouse(tx, room.houseId);
    if (room.planFrame !== 1) throw new ApiError(409, 'not_mirrored', `${room.label} isn't a mirror image`);
    if (await tx.placement.count({ where: { roomId } })) throw new ApiError(409, 'has_furniture', 'Remove the furniture placed in this room first (it would stay mirrored)');
    if (await tx.scanImport.count({ where: { roomId, status: 'pending' } })) throw new ApiError(409, 'pending_scans', 'Promote or reject the pending scans of this room first');
    for (const w of room.walls) if (await anyPin(tx, 'wall', w.id, ['startYIn', 'endYIn'])) throw new ApiError(409, 'pinned', `Wall ${w.label ?? w.id} has a pinned end point; unpin it first`);
    for (const f of room.fixtures) if (f.yIn != null && (await isPinned(tx, 'fixture', f.id, 'yIn'))) throw new ApiError(409, 'pinned', `Fixture ${f.name} has a pinned position; unpin it first`);
    const maxY = Math.max(...room.walls.flatMap((w) => [w.startYIn, w.endYIn]));
    const ops: Op[] = [];
    for (const w of room.walls) {
      if (w.startYIn !== maxY - w.startYIn) ops.push({ op: 'update', entityType: 'wall', entityId: w.id, field: 'startYIn', after: maxY - w.startYIn });
      if (w.endYIn !== maxY - w.endYIn) ops.push({ op: 'update', entityType: 'wall', entityId: w.id, field: 'endYIn', after: maxY - w.endYIn });
    }
    for (const f of room.fixtures) if (f.yIn != null && f.yIn !== maxY - f.yIn) ops.push({ op: 'update', entityType: 'fixture', entityId: f.id, field: 'yIn', after: maxY - f.yIn });
    ops.push({ op: 'update', entityType: 'room', entityId: room.id, field: 'planFrame', after: PLAN_FRAME });
    const { changes } = await applyOps(tx, ops, { workspaceId: null, mode: 'rescan', trusted: true });
    const rev = await commitRevision(tx, { workspaceId: null, houseId: room.houseId, kind: 'rescan', actor: 'michael', changes, note: `Fixed mirror image of ${room.label} (older scan parser)` });
    return { roomId, revision: rev.number, changeRows: changes.length };
  }, { timeout: 60_000 });
}

export async function furnishFromScan(id: number, name?: string) {
  const check = await furnishCheck(id);
  if (!check.ok) throw new ApiError(409, check.code, check.message);
  return prisma.$transaction(async (tx) => {
    const si = await tx.scanImport.findUniqueOrThrow({ where: { id }, include: { data: true } });
    const { scan } = fromRows(si.data);
    if (si.planFrame === 1) scan.objects = unmirrorObjects(scan);
    const ws = await createBlankWorkspace(tx, (name || `${si.label ?? 'Room'} furniture (scan #${id})`).slice(0, 120));
    const templates = new Map((await tx.furnitureTemplate.findMany()).map((t) => [t.slug, t]));
    const ops: Op[] = [];
    let n = 0;
    const skipped: string[] = [];
    for (const o of scan.objects) {
      const m = matchTemplate(o.kind, o.widthIn, o.depthIn, o.heightIn);
      const t = m && templates.get(m.slug);
      if (!m || !t) { skipped.push(`${o.kind} ${o.widthIn}x${o.depthIn}x${o.heightIn}`); continue; }
      const def = templateBySlug.get(m.slug)!;
      const i = n++;
      ops.push({ op: 'create', entityType: 'furniture_item', tempRef: `i${i}`, fields: {
        kind: t.kind, name: (o.label || `${t.name} (scanned)`).slice(0, 160), wIn: Math.max(1, o.widthIn), dIn: Math.max(1, o.depthIn), hIn: Math.max(0, o.heightIn),
        color: def.params.find((p) => p.type === 'color')?.default as string ?? null, status: 'existing', notes: `From scan #${id} (RoomPlan "${o.kind}")`,
      } });
      ops.push({ op: 'create', entityType: 'placement', tempRef: `p${i}`, fields: {
        roomId: si.roomId!, itemId: `$i${i}`, xIn: o.xIn, yIn: o.yIn, rotationDeg: editorRotation(o.rotationDeg), action: 'existing', templateId: t.id,
      } });
      for (const [key, value] of Object.entries(m.params)) ops.push({ op: 'create', entityType: 'placement_param', fields: { placementId: `$p${i}`, key, value } });
    }
    if (!ops.length) throw new ApiError(409, 'nothing_to_furnish', 'The scan has no objects that match a template');
    const { changes } = await applyOps(tx, ops, { workspaceId: ws.id, mode: 'save' });
    const rev = await commitRevision(tx, { workspaceId: ws.id, kind: 'save', actor: 'michael', changes, note: `Furniture from scan #${id}: ${n} piece(s) matched to templates${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}` });
    return { workspaceId: ws.id, revision: rev.number, placements: n, skipped };
  }, { timeout: 60_000 });
}
