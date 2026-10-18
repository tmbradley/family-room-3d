import { execSync } from 'node:child_process';

if (process.env.HP_TEST !== '1' || !process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL)
  throw new Error('Run tests with `npm test` (tests/setup.ts must be loaded with TEST_DATABASE_URL)');

const { prisma } = await import('../server/db.js');
export { prisma };

/**
 * Migrate the test database and empty it. A database is only ever emptied if the test suite itself
 * marked it as a test database the first time it found it empty; a non-empty unmarked database is
 * refused, so tests can never wipe real data.
 */
export async function prepareTestDb() {
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, stdio: 'pipe' });
  const marker = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_hp_test_marker'");
  if (Number(marker[0].n) === 0) {
    if ((await prisma.house.count()) > 0) throw new Error('TEST_DATABASE_URL has data and is not a test database the suite created; refusing');
    await prisma.$executeRawUnsafe('CREATE TABLE `_hp_test_marker` (id INT PRIMARY KEY)');
    return;
  }
  const tables = await prisma.$queryRawUnsafe<{ t: string }[]>(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT IN ('_prisma_migrations', '_hp_test_marker')");
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) await prisma.$executeRawUnsafe(`DELETE FROM \`${t.replace(/`/g, '')}\``);
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}
