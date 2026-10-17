/** Create an agent API key. Only the SHA-256 hash is stored; the plaintext is written to a file (chmod 600).
 *  Usage: DATABASE_URL=... npx tsx scripts/create-agent-key.ts <name> <read|propose|admin> <output-file> */
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { randomToken, sha256 } from '../server/util.js';

const [name, scope, out] = process.argv.slice(2);
if (!name || !['read', 'propose', 'admin'].includes(scope) || !out) throw new Error('usage: create-agent-key.ts <name> <read|propose|admin> <output-file>');
const prisma = new PrismaClient();
const key = `hp_${scope}_${randomToken(32)}`;
await prisma.agentKey.create({ data: { name, scope: scope as any, prefix: key.slice(0, 14), keyHash: sha256(key) } });
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, key + '\n', { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Created ${scope} key "${name}" (prefix ${key.slice(0, 14)}…); plaintext written to ${out}.`);
await prisma.$disconnect();
