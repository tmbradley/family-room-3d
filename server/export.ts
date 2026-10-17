import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from './db.js';
import { exportHouse } from './house.js';

const bucket = process.env.S3_BUCKET;
const s3 =
  bucket && process.env.S3_ENDPOINT
    ? new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION || 'auto',
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
      })
    : null;

export async function runExport() {
  if (!s3 || !bucket) {
    await prisma.export.create({ data: { status: 'skipped', error: 'bucket not configured' } });
    return { status: 'skipped' as const };
  }
  try {
    const body = JSON.stringify(await exportHouse(), null, 2);
    const key = `exports/house-${new Date().toISOString().slice(0, 10)}.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
    await prisma.export.create({ data: { status: 'ok', bucketKey: key, bytes: Buffer.byteLength(body) } });
    return { status: 'ok' as const, key, bytes: Buffer.byteLength(body) };
  } catch (e: any) {
    await prisma.export.create({ data: { status: 'error', error: String(e?.message ?? e).slice(0, 1000) } });
    return { status: 'error' as const, error: String(e?.message ?? e) };
  }
}

/** Nightly export at 07:00 UTC (3 AM Eastern during DST), run inside the web service. */
export function scheduleNightlyExport() {
  const next = () => {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0));
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  };
  const loop = () =>
    setTimeout(async () => {
      const r = await runExport().catch((e) => ({ status: 'error', error: String(e) }));
      console.log('[export]', JSON.stringify(r));
      loop();
    }, next());
  loop();
}
