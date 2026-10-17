/** Usage: DATABASE_URL=... npx tsx scripts/seed.ts /path/to/house.json [--force] */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { seedHouse } from '../server/seed.js';

const file = process.argv[2];
if (!file) throw new Error('usage: seed.ts <house.json> [--force]');
const prisma = new PrismaClient();
console.log(await seedHouse(prisma, JSON.parse(readFileSync(file, 'utf8')), process.argv.includes('--force')));
await prisma.$disconnect();
