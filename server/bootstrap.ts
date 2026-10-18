/**
 * One-time bootstrap from env vars, run at startup. Lets us seed and create credentials
 * without exposing the database publicly or putting plaintext secrets on Railway:
 *  - SEED_HOUSE_JSON_B64: base64 house.json; seeds only if the database has no house.
 *  - BOOTSTRAP_AGENT_KEYS: "name|scope|sha256hex" entries separated by ";" (hash only).
 *  - BOOTSTRAP_SETUP_CODE_HASH: sha256 of a normalized one-time setup code (valid 7 days).
 *  - RUN_EXPORT_ON_START=1: run the JSON export to the bucket once at startup (to test it).
 * Remove these variables once applied; re-running is a no-op.
 */
import { prisma } from './db.js';
import { seedHouse } from './seed.js';
import { runExport } from './export.js';
import { syncTemplates } from './templates.js';

export async function bootstrap() {
  await prisma.$transaction((tx) => syncTemplates(tx), { timeout: 60_000 });
  const seed = process.env.SEED_HOUSE_JSON_B64;
  if (seed && (await prisma.house.count()) === 0) {
    const src = JSON.parse(Buffer.from(seed, 'base64').toString('utf8'));
    console.log('[bootstrap]', await seedHouse(prisma, src));
  }
  for (const entry of (process.env.BOOTSTRAP_AGENT_KEYS ?? '').split(';').filter(Boolean)) {
    const [name, scope, hash] = entry.split('|');
    if (!['read', 'propose', 'admin'].includes(scope) || !/^[0-9a-f]{64}$/.test(hash)) continue;
    if (!(await prisma.agentKey.findUnique({ where: { keyHash: hash } }))) {
      await prisma.agentKey.create({ data: { name, scope: scope as any, prefix: `hp_${scope}_`, keyHash: hash } });
      console.log(`[bootstrap] created ${scope} agent key "${name}"`);
    }
  }
  const sc = process.env.BOOTSTRAP_SETUP_CODE_HASH;
  if (sc && /^[0-9a-f]{64}$/.test(sc) && !(await prisma.setupCode.findUnique({ where: { codeHash: sc } }))) {
    await prisma.setupCode.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date() } });
    await prisma.setupCode.create({ data: { codeHash: sc, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    console.log('[bootstrap] created one-time setup code (valid 7 days)');
  }
  if (process.env.RUN_EXPORT_ON_START === '1') console.log('[bootstrap] export', JSON.stringify(await runExport()));
}
