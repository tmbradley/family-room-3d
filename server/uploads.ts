/**
 * Phone pairing for the scanning App Clip.
 *
 * Michael's signed-in session creates a short-lived pairing code (shown as a QR code). The code is
 * stored only as a SHA-256 hash, expires after TOKEN_EXPIRY_MINUTES, and can do exactly one thing:
 * upload one scan (RoomPlan JSON + USDZ + a few photos) for the room scope it was issued for. Every
 * upload row records the token that created it; completing or importing an upload requires the same
 * token. After the scan is imported the code is spent.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from './db.js';
import { ApiError, humanCode, normalizeCode, randomToken, sha256 } from './util.js';
import { createScanImport } from './scans.js';

export const TOKEN_EXPIRY_MINUTES = 60;
export const DEFAULT_UPLOAD_LIMIT = 12;
const PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60;

const FORMATS = { scan: ['roomplan_json', 'usdz'], photo: ['jpg', 'heic', 'png'] } as const;
export type UploadKindIn = keyof typeof FORMATS;
const CONTENT_TYPES: Record<string, string> = {
  roomplan_json: 'application/json', usdz: 'model/vnd.usdz+zip', jpg: 'image/jpeg', heic: 'image/heic', png: 'image/png',
};

let s3: S3Client | null = null;
function storage() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket || !process.env.S3_ENDPOINT) throw new ApiError(503, 'storage_not_configured', 'File storage is not configured');
  s3 ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'auto', forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' },
  });
  return { s3, bucket };
}

const hashCode = (code: string) => sha256(normalizeCode(code));

/** Michael-only (route-guarded). Exactly one scope: an existing Current room, or a new room with a label. */
export async function generateUploadToken(p: { roomId?: number; newRoom?: boolean; label?: string }) {
  if ((p.roomId != null) === !!p.newRoom) throw new ApiError(400, 'invalid_scope', 'Choose either an existing Current room (roomId) or a new room (newRoom + label)');
  let roomLabel: string;
  if (p.roomId != null) {
    const room = await prisma.room.findUnique({ where: { id: p.roomId } });
    if (!room) throw new ApiError(404, 'room_not_found', `Room ${p.roomId} not found`);
    if (room.draftWorkspaceId !== null) throw new ApiError(400, 'not_current', 'Scans go into Current rooms. To scan a room for the first time, pair for a new room.');
    roomLabel = room.label;
  } else {
    roomLabel = (p.label ?? '').trim();
    if (!roomLabel) throw new ApiError(400, 'label_required', 'Name the room you are about to scan');
  }
  const code = humanCode(3, 4);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60_000);
  await prisma.uploadToken.create({
    data: { tokenHash: hashCode(code), roomId: p.roomId ?? null, newRoom: !!p.newRoom, roomLabel: roomLabel.slice(0, 120), uploadLimit: DEFAULT_UPLOAD_LIMIT, expiresAt },
  });
  return { token: code, expiresAt, scope: p.newRoom ? 'new_room' : 'room', roomId: p.roomId ?? null, roomLabel };
}

/** Look up a pairing code. Unknown, expired, and spent codes are all 401. */
export async function resolveToken(code: string) {
  const t = await prisma.uploadToken.findUnique({ where: { tokenHash: hashCode(code) } });
  if (!t) throw new ApiError(401, 'invalid_token', 'Pairing code not recognized');
  if (t.expiresAt.getTime() <= Date.now()) throw new ApiError(401, 'token_expired', 'Pairing code expired; pair again from the editor');
  if (t.usedAt) throw new ApiError(401, 'token_used', 'This pairing code was already used for a scan; pair again to scan another');
  return t;
}

export async function describeToken(code: string) {
  const t = await resolveToken(code);
  const used = await prisma.upload.count({ where: { tokenId: t.id } });
  return { valid: true, scope: t.newRoom ? 'new_room' : 'room', roomId: t.roomId, roomLabel: t.roomLabel, expiresAt: t.expiresAt, uploadsLeft: Math.max(0, t.uploadLimit - used) };
}

export async function presignUpload(code: string, kind: UploadKindIn, format: string) {
  const t = await resolveToken(code);
  if (!(FORMATS[kind] as readonly string[]).includes(format)) throw new ApiError(400, 'invalid_format', `${kind} uploads must be ${FORMATS[kind].join(' or ')}`);
  const { s3: client, bucket } = storage();
  const house = await prisma.house.findFirst({ orderBy: { id: 'asc' } });
  if (!house) throw new ApiError(404, 'no_house', 'No house');
  const upload = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM upload_tokens WHERE id = ${t.id} FOR UPDATE`;
    if ((await tx.upload.count({ where: { tokenId: t.id } })) >= t.uploadLimit) throw new ApiError(429, 'upload_limit', `This pairing code allows ${t.uploadLimit} files`);
    const bucketKey = `scans/${house.id}/${new Date().toISOString().slice(0, 10)}/${randomToken(12)}.${format === 'roomplan_json' ? 'json' : format}`;
    return tx.upload.create({ data: { houseId: house.id, roomId: t.roomId, tokenId: t.id, kind, format: format as any, bucketKey, status: 'pending', uploadedBy: 'michael' } });
  });
  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: upload.bucketKey, ContentType: CONTENT_TYPES[format] }), { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS });
  return { uploadId: upload.id, url, contentType: CONTENT_TYPES[format], expiresIn: PRESIGNED_URL_EXPIRY_SECONDS };
}

async function ownUpload(tokenId: number, uploadId: number) {
  const u = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!u || u.tokenId !== tokenId) throw new ApiError(403, 'not_your_upload', 'That upload belongs to a different pairing code');
  return u;
}

export async function completeUpload(code: string, uploadId: number, bytes: number) {
  const t = await resolveToken(code);
  const u = await ownUpload(t.id, uploadId);
  if (u.status !== 'pending') throw new ApiError(409, 'already_completed', 'Upload already completed');
  await prisma.$transaction([
    prisma.upload.update({ where: { id: u.id }, data: { status: 'uploaded', bytes } }),
    prisma.uploadToken.update({ where: { id: t.id }, data: { uploadCount: { increment: 1 } } }),
  ]);
  return { uploadId: u.id, status: 'uploaded' as const };
}

/**
 * Turn an uploaded RoomPlan JSON into a scan import for review. The upload must belong to this code,
 * and the room must match the code's scope. Spends the code.
 */
export async function importScan(code: string, p: { uploadId: number; roomplanData: unknown; roomId?: number | null }) {
  const t = await resolveToken(code);
  const u = await ownUpload(t.id, p.uploadId);
  if (u.kind !== 'scan' || u.format !== 'roomplan_json') throw new ApiError(400, 'not_roomplan', 'Import the RoomPlan JSON upload');
  if (u.status !== 'uploaded') throw new ApiError(409, 'not_uploaded', u.status === 'pending' ? 'Finish the upload first' : 'This upload was already imported');
  if (t.newRoom ? p.roomId != null : p.roomId != null && p.roomId !== t.roomId)
    throw new ApiError(403, 'wrong_room', 'This pairing code is for a different room');
  const result = await createScanImport({ houseId: u.houseId, uploadId: u.id, roomplanData: p.roomplanData, label: t.roomLabel ?? 'Scanned room', roomId: t.newRoom ? null : t.roomId });
  await prisma.uploadToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  return result;
}
