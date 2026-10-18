/**
 * Loaded before every test file (npm test: node --import tsx --import ./tests/setup.ts --test ...).
 * Points the app's Prisma client at TEST_DATABASE_URL and nothing else, and refuses to run without
 * it or against anything that looks like a real (Railway) database.
 */
const url = process.env.TEST_DATABASE_URL;
const fail = (msg: string) => { console.error(`\n[tests] ${msg}\n`); process.exit(1); };
if (!url) fail('Set TEST_DATABASE_URL to a throwaway MySQL/MariaDB database, e.g. mysql://u:p@127.0.0.1:3306/hp_test');
let u: URL;
try { u = new URL(url!); } catch { fail('TEST_DATABASE_URL is not a valid URL'); }
const dbName = u!.pathname.replace(/^\//, '');
if (/railway|rlwy/i.test(u!.hostname) || dbName === 'railway') fail('Refusing to run tests against a Railway database');
if (!/test/i.test(dbName)) fail(`Test database name must contain "test" (got "${dbName}")`);
// The app's client (server/db.ts) reads DATABASE_URL; force it to the test database for this process.
process.env.DATABASE_URL = url;
process.env.HP_TEST = '1';
process.env.DISABLE_EXPORT_SCHEDULER = '1';
// Presigning is a local computation; fake storage settings keep tests offline.
process.env.S3_BUCKET = 'test-bucket';
process.env.S3_ENDPOINT = 'http://127.0.0.1:9';
process.env.S3_REGION = 'auto';
process.env.S3_ACCESS_KEY_ID = 'test';
process.env.S3_SECRET_ACCESS_KEY = 'test';
