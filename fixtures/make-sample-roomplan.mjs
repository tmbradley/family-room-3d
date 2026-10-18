// Writes fixtures/sample-roomplan.json (synthetic, Apple RoomPlan CapturedRoom layout; see roomplan-builder.mjs).
import { writeFileSync } from 'node:fs';
import { buildCapturedRoom, SAMPLE } from './roomplan-builder.mjs';
writeFileSync(new URL('./sample-roomplan.json', import.meta.url), JSON.stringify(buildCapturedRoom(SAMPLE), null, 2) + '\n');
