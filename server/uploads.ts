/**
 * Phone pairing for the House Planner iPhone app.
 *
 * Michael's signed-in session creates a short-lived pairing code (shown as a QR code). The code is
 * stored only as a SHA-256 hash, expires after TOKEN_EXPIRY_MINUTES, and has one purpose:
 *  - scan: one room scan (RoomPlan JSON + USDZ) plus photos, for one Current room or a new room;
 *  - model: one Object Capture model of one furniture placement.
 * Every upload row records the code that created it; completing or importing an upload requires the
 * same code. Importing spends the code. Until it expires, a scan code can also send a few measurement
 * suggestions for its room; those become proposals that only Michael can approve.
 */
import { prisma } from './db.js';
import { ApiError, humanCode, normalizeCode, randomToken, sha256 } from './util.js';
import { createScanImport } from './scans.js';
import { recordPhoto } from './photos.js';
import { putObject, signedPutUrl, CONTENT_TYPES, PUT_URL_SECONDS } from './storage.js';
import { applyOps, commitRevision, lockWorkspace } from './changes.js';
import { createMeasurementProposal, type MeasurementSuggestion } from './proposals.js';

export const TOKEN_EXPIRY_MINUTES = 60;
export const DEFAULT_UPLOAD_LIMIT = 24; // JSON + USDZ + up to 20 guided photos, with a little slack
export const MODEL_UPLOAD_LIMIT = 2;
export const MAX_SUGGESTION_BATCHES = 5;
export const MAX_MODEL_BYTES = 200 * 1024 * 1024;

const FORMATS = { scan: ['roomplan_json', 'usdz'], photo: ['jpg', 'heic', 'png'], model: ['usdz', 'glb'] } as const;
export type UploadKindIn = keyof typeof FORMATS;

const hashCode = (code: string) => sha256(normalizeCode(code));

/** Michael-only (route-guarded). Exactly one scope: a Current room, a new room (with a label), or a placement. */
export async function generateUploadToken(p: { roomId?: number; newRoom?: boolean; label?: string; placementId?: number }) {
  const scopes = [p.roomId != null, !!p.newRoom, p.placementId != null].filter(Boolean).length;
  if (scopes !== 1) throw new ApiError(400, 'invalid_scope', 'Choose one: an existing Current room (roomId), a new room (newRoom + label), or a piece of furniture (placementId)');
  let roomLabel: string, roomId: number | null = null, placementId: number | null = null;
  if (p.placementId != null) {
    const pl = await prisma.placement.findUnique({ where: { id: p.placementId }, include: { item: true, room: true } });
    if (!pl || pl.workspaceId == null) throw new ApiError(404, 'placement_not_found', `Placement ${p.placementId} not found`);
    roomLabel = pl.item.name; roomId = pl.roomId; placementId = pl.id;
  } else if (p.roomId != null) {
    const room = await prisma.room.findUnique({ where: { id: p.roomId } });
    if (!room) throw new ApiError(404, 'room_not_found', `Room ${p.roomId} not found`);
    if (room.draftWorkspaceId !== null) throw new ApiError(400, 'not_current', 'Scans go into Current rooms. To scan a room for the first time, pair for a new room.');
    roomLabel = room.label; roomId = room.id;
  } else {
    roomLabel = (p.label ?? '').trim();
    if (!roomLabel) throw new ApiError(400, 'label_required', 'Name the room you are about to scan');
  }
  const code = humanCode(3, 4);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60_000);
  const purpose = placementId != null ? 'model' : 'scan';
  await prisma.uploadToken.create({
    data: {
      tokenHash: hashCode(code), purpose, roomId, placementId, newRoom: !!p.newRoom, roomLabel: roomLabel.slice(0, 120),
      uploadLimit: purpose === 'model' ? MODEL_UPLOAD_LIMIT : DEFAULT_UPLOAD_LIMIT, expiresAt,
    },
  });
  return { token: code, expiresAt, purpose, scope: placementId != null ? 'placement' : p.newRoom ? 'new_room' : 'room', roomId, placementId, roomLabel };
}

/** Look up a pairing code. Unknown and expired codes are 401; spent codes too unless allowUsed. */
export async function resolveToken(code: string, opts: { allowUsed?: boolean } = {}) {
  const t = await prisma.uploadToken.findUnique({ where: { tokenHash: hashCode(code) } });
  if (!t) throw new ApiError(401, 'invalid_token', 'Pairing code not recognized');
  if (t.expiresAt.getTime() <= Date.now()) throw new ApiError(401, 'token_expired', 'Pairing code expired; pair again from the editor');
  if (t.usedAt && !opts.allowUsed) throw new ApiError(401, 'token_used', 'This pairing code was already used; pair again from the editor');
  return t;
}

/** The room a code works on: its own room, or the room its scan created once promoted. */
async function tokenRoomId(t: { id: number; roomId: number | null }) {
  if (t.roomId != null) return t.roomId;
  const si = await prisma.scanImport.findFirst({ where: { upload: { tokenId: t.id }, status: 'promoted' }, select: { roomId: true } });
  return si?.roomId ?? null;
}

export async function describeToken(code: string) {
  const t = await resolveToken(code, { allowUsed: true });
  const used = await prisma.upload.count({ where: { tokenId: t.id } });
  const roomId = await tokenRoomId(t);
  return {
    valid: !t.usedAt, spent: !!t.usedAt, purpose: t.purpose, scope: t.placementId != null ? 'placement' : t.newRoom ? 'new_room' : 'room',
    roomId, placementId: t.placementId, roomLabel: t.roomLabel, expiresAt: t.expiresAt,
    uploadsLeft: t.usedAt ? 0 : Math.max(0, t.uploadLimit - used),
    canSuggestMeasurements: t.purpose === 'scan' && roomId != null && t.suggestionCount < MAX_SUGGESTION_BATCHES,
  };
}

export async function presignUpload(code: string, kind: UploadKindIn, format: string) {
  const t = await resolveToken(code);
  const allowedKinds: UploadKindIn[] = t.purpose === 'model' ? ['model'] : ['scan', 'photo'];
  if (!allowedKinds.includes(kind)) throw new ApiError(403, 'wrong_purpose', `This pairing code is for ${t.purpose === 'model' ? 'a furniture model' : 'a room scan and photos'}`);
  if (!(FORMATS[kind] as readonly string[]).includes(format)) throw new ApiError(400, 'invalid_format', `${kind} uploads must be ${FORMATS[kind].join(' or ')}`);
  const house = await prisma.house.findFirst({ orderBy: { id: 'asc' } });
  if (!house) throw new ApiError(404, 'no_house', 'No house');
  const upload = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM upload_tokens WHERE id = ${t.id} FOR UPDATE`;
    if ((await tx.upload.count({ where: { tokenId: t.id } })) >= t.uploadLimit) throw new ApiError(429, 'upload_limit', `This pairing code allows ${t.uploadLimit} files`);
    const folder = kind === 'model' ? 'models' : 'scans';
    const bucketKey = `${folder}/${house.id}/${new Date().toISOString().slice(0, 10)}/${randomToken(12)}.${format === 'roomplan_json' ? 'json' : format}`;
    return tx.upload.create({ data: { houseId: house.id, roomId: t.roomId, tokenId: t.id, kind, format: format as any, bucketKey, status: 'pending', uploadedBy: 'michael' } });
  });
  return { uploadId: upload.id, url: await signedPutUrl(upload.bucketKey, format), contentType: CONTENT_TYPES[format], expiresIn: PUT_URL_SECONDS };
}

async function ownUpload(tokenId: number, uploadId: number) {
  const u = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!u || u.tokenId !== tokenId) throw new ApiError(403, 'not_your_upload', 'That upload belongs to a different pairing code');
  return u;
}

export type PhotoMeta = { prompt?: string; note?: string; roomTag?: string; tags?: string[] };

/** Mark an upload done. Photos also get their scan_photos row (note, tags, room). */
export async function completeUpload(code: string, uploadId: number, bytes: number, photo?: PhotoMeta) {
  const t = await resolveToken(code);
  const u = await ownUpload(t.id, uploadId);
  if (u.status !== 'pending') throw new ApiError(409, 'already_completed', 'Upload already completed');
  await prisma.$transaction(async (tx) => {
    await tx.upload.update({ where: { id: u.id }, data: { status: 'uploaded', bytes } });
    await tx.uploadToken.update({ where: { id: t.id }, data: { uploadCount: { increment: 1 } } });
    if (u.kind === 'photo') await recordPhoto(tx, { uploadId: u.id, roomId: t.roomId, ...photo });
  });
  return { uploadId: u.id, status: 'uploaded' as const };
}

/**
 * Turn an uploaded RoomPlan JSON into a scan import for review. The upload must belong to this code,
 * and the room must match the code's scope. Links the code's photos to the scan. Spends the code.
 */
export async function importScan(code: string, p: { uploadId: number; roomplanData: unknown; roomId?: number | null; objectLabels?: Record<string, string> }) {
  const t = await resolveToken(code);
  if (t.purpose !== 'scan') throw new ApiError(403, 'wrong_purpose', 'This pairing code is for a furniture model');
  const u = await ownUpload(t.id, p.uploadId);
  if (u.kind !== 'scan' || u.format !== 'roomplan_json') throw new ApiError(400, 'not_roomplan', 'Import the RoomPlan JSON upload');
  if (u.status !== 'uploaded') throw new ApiError(409, 'not_uploaded', u.status === 'pending' ? 'Finish the upload first' : 'This upload was already imported');
  if (t.newRoom ? p.roomId != null : p.roomId != null && p.roomId !== t.roomId)
    throw new ApiError(403, 'wrong_room', 'This pairing code is for a different room');
  const result = await createScanImport({
    houseId: u.houseId, uploadId: u.id, roomplanData: p.roomplanData, label: t.roomLabel ?? 'Scanned room',
    roomId: t.newRoom ? null : t.roomId, tokenId: t.id, objectLabels: p.objectLabels,
  });
  await prisma.uploadToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  return result;
}

/** Object Capture model for the code's placement: stored, then attached as a revision. Spends the code. */
export async function importModel(code: string, p: { uploadId: number; label?: string }) {
  const t = await resolveToken(code);
  if (t.purpose !== 'model' || t.placementId == null) throw new ApiError(403, 'wrong_purpose', 'This pairing code is for a room scan');
  const u = await ownUpload(t.id, p.uploadId);
  if (u.kind !== 'model') throw new ApiError(400, 'not_model', 'Import the model upload');
  if (u.status !== 'uploaded') throw new ApiError(409, 'not_uploaded', u.status === 'pending' ? 'Finish the upload first' : 'This upload was already imported');
  const r = await prisma.$transaction(async (tx) => {
    const model = await tx.furnitureModel.create({ data: { houseId: u.houseId, uploadId: u.id, label: (p.label || t.roomLabel || 'Captured piece').slice(0, 160), source: 'object_capture' } });
    await tx.upload.update({ where: { id: u.id }, data: { status: 'imported' } });
    const attached = await attachModel(tx, t.placementId!, model.id, `Attached captured model "${model.label}" (from the iPhone)`);
    await tx.uploadToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
    return { modelId: model.id, ...attached };
  }, { timeout: 30_000 });
  return r;
}

/** Set placement.modelId as a normal revision of the placement's workspace (rollback-able). */
export async function attachModel(tx: any, placementId: number, modelId: number | null, note: string) {
  const pl = await tx.placement.findUnique({ where: { id: placementId } });
  if (!pl || pl.workspaceId == null) throw new ApiError(404, 'placement_not_found', `Placement ${placementId} not found`);
  await lockWorkspace(tx, pl.workspaceId);
  const { changes } = await applyOps(tx, [{ op: 'update', entityType: 'placement', entityId: placementId, field: 'modelId', after: modelId }], { workspaceId: pl.workspaceId, mode: 'save' });
  const rev = changes.length ? await commitRevision(tx, { workspaceId: pl.workspaceId, kind: 'save', actor: 'michael', note, changes }) : null;
  return { placementId, workspaceId: pl.workspaceId, revision: rev?.number ?? null };
}

/** Michael uploads a USDZ/GLB from the editor (session-only route). Optionally attaches it. */
export async function uploadModelFile(p: { bytes: Uint8Array; format: 'usdz' | 'glb'; label: string; placementId?: number }) {
  if (p.bytes.byteLength > MAX_MODEL_BYTES) throw new ApiError(413, 'too_large', 'Models must be under 200 MB');
  const magicOk = p.format === 'glb' ? Buffer.from(p.bytes.slice(0, 4)).toString('latin1') === 'glTF' : p.bytes[0] === 0x50 && p.bytes[1] === 0x4b; // USDZ is a zip
  if (!magicOk) throw new ApiError(400, 'invalid_model', p.format === 'glb' ? 'Not a binary glTF (.glb) file' : 'Not a USDZ file');
  const house = await prisma.house.findFirst({ orderBy: { id: 'asc' } });
  if (!house) throw new ApiError(404, 'no_house', 'No house');
  const bucketKey = `models/${house.id}/${new Date().toISOString().slice(0, 10)}/${randomToken(12)}.${p.format}`;
  await putObject(bucketKey, p.bytes, p.format);
  return prisma.$transaction(async (tx) => {
    const u = await tx.upload.create({ data: { houseId: house.id, kind: 'model', format: p.format, bucketKey, bytes: p.bytes.byteLength, status: 'imported', uploadedBy: 'michael' } });
    const model = await tx.furnitureModel.create({ data: { houseId: house.id, uploadId: u.id, label: p.label.slice(0, 160) || 'Model', source: 'upload' } });
    const attached = p.placementId != null ? await attachModel(tx, p.placementId, model.id, `Attached model "${model.label}"`) : null;
    return { modelId: model.id, format: p.format, attached };
  }, { timeout: 30_000 });
}

/** Walls, openings and ceiling of the code's room, so the phone can point suggestions at real ids. */
export async function tokenRoomOutline(code: string) {
  const t = await resolveToken(code, { allowUsed: true });
  const roomId = await tokenRoomId(t);
  if (roomId == null) throw new ApiError(409, 'no_room_yet', 'This room is not in Current yet. Promote the scan in the editor first.');
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { walls: { include: { openings: true }, orderBy: { id: 'asc' } } } });
  return {
    roomId: room.id, label: room.label, ceilingIn: room.ceilingIn,
    walls: room.walls.filter((w) => !w.isOpen).map((w, i) => ({ id: w.id, label: w.label ?? `Wall ${i + 1}`, lengthIn: Math.round(Math.hypot(w.endXIn - w.startXIn, w.endYIn - w.startYIn)), heightIn: w.heightIn })),
    openings: room.walls.flatMap((w) => w.openings.map((o) => ({ id: o.id, wallId: w.id, type: o.type, label: o.label, widthIn: o.widthIn, sillIn: o.sillIn, headIn: o.headIn }))),
  };
}

/** Measurement suggestions from the phone become one pending proposal (Michael approves in the editor). */
export async function submitSuggestions(code: string, p: { notes: string; suggestions: MeasurementSuggestion[]; method: 'on_device_model' | 'keywords' | 'manual' }) {
  const t = await resolveToken(code, { allowUsed: true });
  if (t.purpose !== 'scan') throw new ApiError(403, 'wrong_purpose', 'Use a room pairing code');
  const roomId = await tokenRoomId(t);
  if (roomId == null) throw new ApiError(409, 'no_room_yet', 'This room is not in Current yet. Promote the scan in the editor first.');
  const claimed = await prisma.uploadToken.updateMany({ where: { id: t.id, suggestionCount: { lt: MAX_SUGGESTION_BATCHES } }, data: { suggestionCount: { increment: 1 } } });
  if (!claimed.count) throw new ApiError(429, 'suggestion_limit', `A pairing code can send ${MAX_SUGGESTION_BATCHES} batches of suggestions`);
  try {
    return await createMeasurementProposal({ roomId, notes: p.notes, suggestions: p.suggestions, method: p.method });
  } catch (e) {
    await prisma.uploadToken.update({ where: { id: t.id }, data: { suggestionCount: { decrement: 1 } } }); // invalid batches don't count
    throw e;
  }
}
