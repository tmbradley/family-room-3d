/**
 * Room photos from the iPhone app. Each photo upload gets a scan_photos row linking it to the scan
 * import made with the same pairing code and to its room, plus the note and tags from the phone.
 * Files stay private in the bucket; views return signed URLs that expire after a few minutes.
 */
import { prisma } from './db.js';
import { ApiError } from './util.js';
import { signedGetUrl, VIEW_URL_SECONDS } from './storage.js';
import type { Tx } from './entities.js';

export const MAX_TAGS = 8;
export const cleanTags = (tags: unknown) =>
  [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().trim().replace(/[^a-z0-9 _-]/g, '').slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS);

const include = { upload: true, tags: true, room: { select: { id: true, label: true } } } as const;
type Row = Awaited<ReturnType<typeof prisma.scanPhoto.findMany<{ include: typeof include }>>>[number];

async function view(p: Row) {
  return {
    id: p.id, scanImportId: p.scanImportId, room: p.room, prompt: p.prompt, note: p.note, roomTag: p.roomTag,
    tags: p.tags.map((t) => t.tag), format: p.upload.format, bytes: p.upload.bytes, takenAt: p.createdAt,
    url: await signedGetUrl(p.upload.bucketKey, p.upload.format), urlExpiresInSeconds: VIEW_URL_SECONDS,
  };
}

export async function listPhotos(filter: { roomId?: number; scanImportId?: number; ids?: number[] }) {
  if (filter.roomId == null && filter.scanImportId == null && !filter.ids) throw new ApiError(400, 'filter_required', 'Pass roomId or scanImportId');
  const rows = await prisma.scanPhoto.findMany({
    where: {
      ...(filter.roomId != null ? { roomId: filter.roomId } : {}),
      ...(filter.scanImportId != null ? { scanImportId: filter.scanImportId } : {}),
      ...(filter.ids ? { id: { in: filter.ids } } : {}),
      upload: { status: { in: ['uploaded', 'imported'] } },
    },
    include, orderBy: { id: 'asc' },
  });
  return Promise.all(rows.map(view));
}

/** Called when a photo upload completes. */
export async function recordPhoto(tx: Tx, p: { uploadId: number; roomId: number | null; prompt?: string; note?: string; roomTag?: string; tags?: unknown }) {
  const row = await tx.scanPhoto.create({
    data: { uploadId: p.uploadId, roomId: p.roomId, prompt: p.prompt?.slice(0, 120) || null, note: p.note?.slice(0, 1000) || null, roomTag: p.roomTag?.trim().slice(0, 60) || null },
  });
  const tags = cleanTags(p.tags);
  if (tags.length) await tx.photoTag.createMany({ data: tags.map((tag) => ({ photoId: row.id, tag })) });
  return row;
}
