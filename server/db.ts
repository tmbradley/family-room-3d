import { PrismaClient } from '@prisma/client';

// Under the test runner (tests/setup.ts sets HP_TEST), the client may only ever use TEST_DATABASE_URL.
const testing = process.env.HP_TEST === '1';
if (testing && (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL))
  throw new Error('Tests must run with DATABASE_URL = TEST_DATABASE_URL (load tests/setup.ts)');
export const prisma = new PrismaClient(testing ? { datasources: { db: { url: process.env.TEST_DATABASE_URL! } } } : undefined);
