/**
 * Cost of what a change list puts on the plan: new pieces at their own price, or the template's
 * typical range when they have none, and per-wall paint or limewash. Shown next to the proposal's
 * own cost steps (which stay the agent's step-by-step estimate) so pieces drawn on the plan are
 * always counted.
 */
import type { Op } from './changes.js';
import { templateBySlug } from './templates.js';
import { prisma } from './db.js';

/** Per wall, DIY low to pro high, USD. */
export const WALL_FINISH_COST: Record<string, [number, number]> = { paint: [40, 250], limewash: [90, 450] };

export type CostLine = { what: string; lowUsd: number; highUsd: number; basis: 'price' | 'typical' | 'wall_finish' };

export async function estimateOps(ops: Op[]): Promise<{ lowUsd: number; highUsd: number; lines: CostLine[] }> {
  const items = new Map<string, Record<string, unknown>>();
  for (const o of ops) if (o.op === 'create' && o.entityType === 'furniture_item' && o.tempRef) items.set(o.tempRef, o.fields);
  const templates = await prisma.furnitureTemplate.findMany({ select: { id: true, slug: true, name: true } });
  const lines: CostLine[] = [];
  const counted = new Set<string>();
  for (const o of ops) {
    if (o.op === 'create' && o.entityType === 'placement') {
      if (String(o.fields.action ?? '') !== 'new') continue;
      const ref = typeof o.fields.itemId === 'string' && o.fields.itemId.startsWith('$') ? o.fields.itemId.slice(1) : null;
      const item = ref ? items.get(ref) : null;
      const itemRow = !ref && o.fields.itemId != null ? await prisma.furnitureItem.findUnique({ where: { id: Number(o.fields.itemId) } }) : null;
      const name = String(item?.name ?? itemRow?.name ?? 'New piece');
      const price = item?.priceCents != null && item.priceCents !== '' ? Number(item.priceCents) : itemRow?.priceCents ?? null;
      if (ref) counted.add(ref);
      if (price != null && Number.isFinite(price)) { lines.push({ what: name, lowUsd: price / 100, highUsd: price / 100, basis: 'price' }); continue; }
      const t = o.fields.templateId != null ? templates.find((x) => x.id === Number(o.fields.templateId)) : null;
      const def = t ? templateBySlug.get(t.slug) : null;
      if (def?.price) lines.push({ what: `${name} (typical ${def.name.toLowerCase()})`, lowUsd: def.price[0], highUsd: def.price[1], basis: 'typical' });
    }
    if (o.entityType === 'wall_style' && (o.op === 'create' || (o.op === 'update' && ['color', 'finish'].includes(o.field)))) {
      const key = o.op === 'create' ? `new:${o.tempRef ?? lines.length}` : `ws:${o.entityId}`;
      if (counted.has(key)) continue;
      counted.add(key);
      let finish = o.op === 'create' ? String(o.fields.finish ?? 'paint') : o.field === 'finish' ? String(o.after ?? 'paint') : null;
      if (finish == null && o.op === 'update') finish = (await prisma.wallStyle.findUnique({ where: { id: o.entityId } }))?.finish ?? 'paint';
      const c = WALL_FINISH_COST[finish!] ?? WALL_FINISH_COST.paint;
      lines.push({ what: `${finish === 'limewash' ? 'Limewash' : 'Paint'} one wall`, lowUsd: c[0], highUsd: c[1], basis: 'wall_finish' });
    }
  }
  const sum = (k: 'lowUsd' | 'highUsd') => Math.round(lines.reduce((a, l) => a + l[k], 0) * 100) / 100;
  return { lowUsd: sum('lowUsd'), highUsd: sum('highUsd'), lines };
}
