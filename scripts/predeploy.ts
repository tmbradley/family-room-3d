/**
 * Railway pre-deploy step (runs before the new version takes traffic; if it fails, the old
 * version keeps running):
 *  1. Snapshot every table to the bucket as JSON (schema-agnostic raw SQL), so a bad migration
 *     can be recovered from. Skipped if the bucket isn't configured or there are no tables yet.
 *  2. prisma migrate deploy (applies only committed migrations; never resets or drops data).
 */
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const prisma = new PrismaClient();
async function snapshot() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket || !process.env.S3_ENDPOINT) { console.log('[predeploy] bucket not configured; skipping snapshot'); return; }
  const tables = await prisma.$queryRawUnsafe<{ t: string }[]>(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  if (!tables.length) { console.log('[predeploy] empty database; skipping snapshot'); return; }
  const out: Record<string, unknown[]> = {};
  for (const { t } of tables) out[t] = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM \`${t.replace(/`/g, '')}\``);
  const body = JSON.stringify({ takenAt: new Date().toISOString(), tables: out }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? { base64: Buffer.from(v).toString('base64') } : v);
  const key = `backups/predeploy-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'auto',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' },
  });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
  console.log(`[predeploy] snapshot ${key} (${tables.length} tables, ${Buffer.byteLength(body)} bytes)`);
}

await snapshot();
await prisma.$disconnect();
execSync('npx prisma migrate deploy', { stdio: 'inherit' });
console.log('[predeploy] migrations applied');
