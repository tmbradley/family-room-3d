/** The Railway bucket (S3-compatible). Files are private; access is through short-lived signed URLs. */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ApiError } from './util.js';

/** Signed GET URLs for photos and models last this long. */
export const VIEW_URL_SECONDS = 10 * 60;
export const PUT_URL_SECONDS = 15 * 60;

export const CONTENT_TYPES: Record<string, string> = {
  roomplan_json: 'application/json', usdz: 'model/vnd.usdz+zip', glb: 'model/gltf-binary', jpg: 'image/jpeg', heic: 'image/heic', png: 'image/png',
};

let s3: S3Client | null = null;
export function storage() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket || !process.env.S3_ENDPOINT) throw new ApiError(503, 'storage_not_configured', 'File storage is not configured');
  s3 ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'auto', forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' },
  });
  return { s3, bucket };
}

export async function signedPutUrl(key: string, format: string) {
  const { s3: c, bucket } = storage();
  return getSignedUrl(c, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: CONTENT_TYPES[format] }), { expiresIn: PUT_URL_SECONDS });
}

export async function signedGetUrl(key: string, format: string, seconds = VIEW_URL_SECONDS) {
  const { s3: c, bucket } = storage();
  return getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: CONTENT_TYPES[format] }), { expiresIn: seconds });
}

export async function putObject(key: string, body: Uint8Array, format: string) {
  const { s3: c, bucket } = storage();
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: CONTENT_TYPES[format] }));
}

export async function getObject(key: string) {
  const { s3: c, bucket } = storage();
  const r = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!r.Body) throw new ApiError(404, 'file_missing', 'File not found in storage');
  return r;
}
