import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from './db.js';
import { randomToken, sha256, humanCode } from './util.js';
import { ApiError } from './util.js';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET || 'house-planner-uploads';
const TOKEN_EXPIRY_MINUTES = 60;
const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

export interface UploadToken {
  token: string;
  expiresAt: Date;
}

/**
 * Generate a short-lived upload token for the App Clip.
 * The token can be used to upload scan data for a specific room or a new room.
 */
export async function generateUploadToken(params: { roomId?: number; newRoom?: boolean; uploadLimit?: number }): Promise<UploadToken> {
  const token = humanCode(3, 4); // e.g. "ABCD-EFGH-IJKL"
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await prisma.uploadToken.create({
    data: {
      tokenHash: sha256(token.replace(/-/g, '').toLowerCase()),
      roomId: params.roomId ?? null,
      newRoom: params.newRoom ?? false,
      uploadLimit: params.uploadLimit ?? 10,
      uploadCount: 0,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/**
 * Exchange an upload token for authenticated access.
 * Returns the token record if valid.
 */
export async function validateUploadToken(token: string) {
  const normalized = token.replace(/-/g, '').toLowerCase();
  const record = await prisma.uploadToken.findUnique({
    where: { tokenHash: sha256(normalized) },
    include: { uploads: true },
  });

  if (!record) {
    throw new ApiError(401, 'invalid_token', 'Upload token not found');
  }

  if (record.expiresAt < new Date()) {
    throw new ApiError(401, 'token_expired', 'Upload token has expired');
  }

  if (record.uploadCount >= record.uploadLimit) {
    throw new ApiError(429, 'upload_limit_reached', `Upload limit of ${record.uploadLimit} reached for this token`);
  }

  return record;
}

/**
 * Increment the upload count for a token.
 */
export async function incrementTokenUploadCount(tokenId: number) {
  await prisma.uploadToken.update({
    where: { id: tokenId },
    data: { 
      uploadCount: { increment: 1 },
      usedAt: new Date(),
    },
  });
}

export interface PresignedUpload {
  uploadId: number;
  url: string;
  bucketKey: string;
  expiresIn: number;
}

/**
 * Generate a presigned S3 URL for uploading a file.
 * Creates an Upload record in the database with status 'pending'.
 */
export async function generatePresignedUpload(params: {
  houseId: number;
  roomId?: number;
  tokenId?: number;
  kind: 'scan' | 'photo';
  format: 'usdz' | 'glb' | 'roomplan_json' | 'jpg' | 'heic' | 'png';
  scanImportId?: number;
}): Promise<PresignedUpload> {
  const { houseId, roomId, tokenId, kind, format, scanImportId } = params;

  // Generate unique bucket key
  const timestamp = Date.now();
  const random = randomToken().slice(0, 8);
  const bucketKey = `${kind}s/${houseId}/${timestamp}-${random}.${format}`;

  // Create upload record
  const upload = await prisma.upload.create({
    data: {
      houseId,
      roomId: roomId ?? null,
      tokenId: tokenId ?? null,
      kind,
      format,
      bucketKey,
      status: 'pending',
      uploadedBy: 'system',
      scanImportId: scanImportId ?? null,
    },
  });

  // Generate presigned URL
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: bucketKey,
    ContentType: getContentType(format),
  });

  const url = await getSignedUrl(s3, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return {
    uploadId: upload.id,
    url,
    bucketKey,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Mark an upload as completed after successful S3 upload.
 * Verifies that the upload belongs to the given token.
 */
export async function completeUpload(uploadId: number, bytes: number, tokenId?: number) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  
  if (!upload) {
    throw new ApiError(404, 'upload_not_found', 'Upload not found');
  }

  if (tokenId && upload.tokenId !== tokenId) {
    throw new ApiError(403, 'forbidden', 'This upload does not belong to your token');
  }

  await prisma.upload.update({
    where: { id: uploadId },
    data: {
      status: 'uploaded',
      bytes,
    },
  });
  
  if (tokenId) {
    await incrementTokenUploadCount(tokenId);
  }
}

function getContentType(format: string): string {
  switch (format) {
    case 'usdz':
      return 'model/vnd.usdz+zip';
    case 'glb':
      return 'model/gltf-binary';
    case 'roomplan_json':
      return 'application/json';
    case 'jpg':
      return 'image/jpeg';
    case 'heic':
      return 'image/heic';
    case 'png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}
