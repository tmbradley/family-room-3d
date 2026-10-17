/** Create a one-time passkey setup code (valid 7 days). Older unused codes are expired.
 *  Usage: DATABASE_URL=... npx tsx scripts/create-setup-code.ts <output-file>  (writes the code there, chmod 600) */
import { writeFileSync, chmodSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { humanCode, normalizeCode, sha256 } from '../server/util.js';

const prisma = new PrismaClient();
const out = process.argv[2];
if (!out) throw new Error('usage: create-setup-code.ts <output-file>');
const code = humanCode(3, 4);
await prisma.setupCode.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date() } });
await prisma.setupCode.create({ data: { codeHash: sha256(normalizeCode(code)), expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
writeFileSync(out, code + '\n', { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Setup code written to ${out} (expires in 7 days).`);
await prisma.$disconnect();
