/**
 * Parametric furniture library. The definitions live here (code), and syncTemplates() mirrors them
 * into furniture_templates / template_params / template_param_options / template_categories at
 * startup, so the database stays relational and foreign keys work. Placements pick a template
 * (placements.template_id) and store their values in placement_params, which go through the
 * change engine like any other field (revisions, proposals, rollback).
 */
import type { Tx } from './entities.js';
import { ApiError } from './util.js';

type Param =
  | { key: string; label: string; type: 'number'; default: number; min: number; max: number }
  | { key: string; label: string; type: 'choice'; default: string; options: [string, string][] }
  | { key: string; label: string; type: 'color'; default: string }
  | { key: string; label: string; type: 'boolean'; default: boolean };

export type TemplateDef = { slug: string; name: string; kind: string; w: number; d: number; h: number; categories: string[]; params: Param[] };

const legStyle: Param = { key: 'legStyle', label: 'Legs', type: 'choice', default: 'tapered', options: [['tapered', 'Tapered wood'], ['block', 'Block'], ['metal', 'Metal'], ['plinth', 'Plinth (no legs)']] };
const legHeight: Param = { key: 'legHeightIn', label: 'Leg height (in)', type: 'number', default: 4, min: 0, max: 30 };
const fabric: Param = { key: 'fabricColor', label: 'Fabric', type: 'color', default: '#5b5f66' };
const wood: Param = { key: 'woodTone', label: 'Wood tone', type: 'choice', default: 'walnut', options: [['walnut', 'Walnut'], ['oak', 'Oak'], ['white_oak', 'White oak'], ['ebony', 'Ebony'], ['painted_white', 'Painted white']] };
const metal: Param = { key: 'metalFinish', label: 'Metal finish', type: 'choice', default: 'brass', options: [['brass', 'Brass'], ['black', 'Black'], ['chrome', 'Chrome'], ['bronze', 'Bronze']] };
const arms: Param = { key: 'armStyle', label: 'Arms', type: 'choice', default: 'track', options: [['track', 'Track'], ['rolled', 'Rolled'], ['slope', 'Sloped'], ['none', 'Armless']] };
const seatDepth: Param = { key: 'seatDepthIn', label: 'Seat depth (in)', type: 'number', default: 22, min: 16, max: 36 };
const cushions = (d: number): Param => ({ key: 'cushionCount', label: 'Seat cushions', type: 'number', default: d, min: 1, max: 6 });

export const TEMPLATES: TemplateDef[] = [
  { slug: 'l_sectional', name: 'L-sectional', kind: 'sectional', w: 112, d: 86, h: 32, categories: ['sofa'],
    params: [arms, { key: 'chaiseSide', label: 'Chaise side', type: 'choice', default: 'right', options: [['left', 'Left'], ['right', 'Right']] },
      { key: 'chaiseDepthIn', label: 'Chaise length (in)', type: 'number', default: 66, min: 40, max: 120 }, seatDepth, cushions(3), fabric, legStyle, legHeight] },
  { slug: 'sofa', name: 'Sofa', kind: 'sofa', w: 84, d: 36, h: 32, categories: ['sofa'], params: [arms, seatDepth, cushions(3), fabric, legStyle, legHeight, wood] },
  { slug: 'armchair', name: 'Armchair', kind: 'chair', w: 32, d: 34, h: 32, categories: ['chair', 'sofa'], params: [arms, fabric, legStyle, legHeight, wood] },
  { slug: 'swivel_chair', name: 'Swivel chair', kind: 'chair', w: 32, d: 34, h: 30, categories: ['chair'],
    params: [fabric, { key: 'baseStyle', label: 'Base', type: 'choice', default: 'disc', options: [['disc', 'Round disc'], ['star', 'Star base']] }, metal] },
  { slug: 'coffee_table', name: 'Coffee table', kind: 'table', w: 48, d: 24, h: 16, categories: ['table'],
    params: [{ key: 'shape', label: 'Top', type: 'choice', default: 'rect', options: [['rect', 'Rectangle'], ['round', 'Round'], ['oval', 'Oval']] }, wood, legStyle, metal] },
  { slug: 'side_table', name: 'Side table', kind: 'table', w: 20, d: 20, h: 24, categories: ['table'],
    params: [{ key: 'shape', label: 'Top', type: 'choice', default: 'round', options: [['rect', 'Square'], ['round', 'Round']] }, wood, metal] },
  { slug: 'media_console', name: 'Media console', kind: 'media', w: 70, d: 18, h: 24, categories: ['storage'],
    params: [{ key: 'doorCount', label: 'Doors', type: 'number', default: 3, min: 0, max: 6 }, wood, legStyle, legHeight, metal] },
  { slug: 'rug', name: 'Rug', kind: 'rug', w: 96, d: 120, h: 0, categories: [],
    params: [{ key: 'rugColor', label: 'Color', type: 'color', default: '#9a9184' }, { key: 'pattern', label: 'Pattern', type: 'choice', default: 'solid', options: [['solid', 'Solid'], ['border', 'Border'], ['geometric', 'Geometric']] }] },
  { slug: 'floor_lamp', name: 'Floor lamp', kind: 'lamp', w: 14, d: 14, h: 62, categories: [],
    params: [metal, { key: 'shadeColor', label: 'Shade', type: 'color', default: '#efe7d8' }, { key: 'arc', label: 'Arc lamp', type: 'boolean', default: false }] },
  { slug: 'bed', name: 'Bed', kind: 'bed', w: 64, d: 84, h: 44, categories: ['bed'],
    params: [{ key: 'size', label: 'Size', type: 'choice', default: 'queen', options: [['twin', 'Twin'], ['full', 'Full'], ['queen', 'Queen'], ['king', 'King']] },
      { key: 'headboard', label: 'Headboard', type: 'choice', default: 'upholstered', options: [['upholstered', 'Upholstered'], ['wood', 'Wood'], ['none', 'None']] }, fabric, wood, legHeight] },
  { slug: 'dresser', name: 'Dresser', kind: 'storage', w: 60, d: 20, h: 34, categories: ['storage'],
    params: [{ key: 'drawerCount', label: 'Drawers', type: 'number', default: 6, min: 2, max: 12 }, wood, metal, legStyle, legHeight] },
  { slug: 'nightstand', name: 'Nightstand', kind: 'storage', w: 22, d: 18, h: 25, categories: ['storage', 'table'],
    params: [{ key: 'drawerCount', label: 'Drawers', type: 'number', default: 2, min: 0, max: 4 }, wood, metal, legStyle, legHeight] },
  { slug: 'desk', name: 'Desk', kind: 'desk', w: 54, d: 26, h: 30, categories: ['table'], params: [wood, legStyle, metal, { key: 'drawers', label: 'Drawer', type: 'boolean', default: true }] },
  { slug: 'bookshelf', name: 'Bookshelf', kind: 'storage', w: 36, d: 14, h: 72, categories: ['storage'],
    params: [{ key: 'shelfCount', label: 'Shelves', type: 'number', default: 5, min: 1, max: 10 }, wood, { key: 'backPanel', label: 'Back panel', type: 'boolean', default: true }] },
];

export const templateBySlug = new Map(TEMPLATES.map((t) => [t.slug, t]));

/** Mirror TEMPLATES into the database (idempotent; keeps ids stable by slug). */
export async function syncTemplates(tx: Tx) {
  for (const t of TEMPLATES) {
    const row = await tx.furnitureTemplate.upsert({
      where: { slug: t.slug },
      create: { slug: t.slug, name: t.name, kind: t.kind, defaultWIn: t.w, defaultDIn: t.d, defaultHIn: t.h },
      update: { name: t.name, kind: t.kind, defaultWIn: t.w, defaultDIn: t.d, defaultHIn: t.h },
    });
    await tx.templateCategory.deleteMany({ where: { templateId: row.id } });
    if (t.categories.length) await tx.templateCategory.createMany({ data: t.categories.map((category) => ({ templateId: row.id, category })) });
    await tx.templateParam.deleteMany({ where: { templateId: row.id, key: { notIn: t.params.map((p) => p.key) } } });
    for (const [sort, p] of t.params.entries()) {
      const data = {
        label: p.label, type: p.type, defaultValue: String(p.default), sort,
        minValue: p.type === 'number' ? p.min : null, maxValue: p.type === 'number' ? p.max : null,
      };
      const param = await tx.templateParam.upsert({ where: { templateId_key: { templateId: row.id, key: p.key } }, create: { templateId: row.id, key: p.key, ...data }, update: data });
      await tx.templateParamOption.deleteMany({ where: { paramId: param.id } });
      if (p.type === 'choice') await tx.templateParamOption.createMany({ data: p.options.map(([value, label], i) => ({ paramId: param.id, value, label, sort: i })) });
    }
  }
}

/** Templates as stored (what agents and the editor see). */
export async function listTemplates(tx: Tx) {
  const rows = await tx.furnitureTemplate.findMany({
    orderBy: { id: 'asc' },
    include: { categories: true, params: { orderBy: { sort: 'asc' }, include: { options: { orderBy: { sort: 'asc' } } } } },
  });
  return rows.map((t) => ({
    id: t.id, slug: t.slug, name: t.name, kind: t.kind, defaults: { wIn: t.defaultWIn, dIn: t.defaultDIn, hIn: t.defaultHIn },
    roomplanCategories: t.categories.map((c) => c.category),
    params: t.params.map((p) => ({
      key: p.key, label: p.label, type: p.type, default: p.defaultValue,
      ...(p.type === 'number' ? { min: p.minValue, max: p.maxValue } : {}),
      ...(p.type === 'choice' ? { options: p.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    })),
  }));
}

/** Validate one parameter value for a template; returns the normalized string. */
export function checkParam(slug: string, key: string, value: unknown): string {
  const t = templateBySlug.get(slug);
  if (!t) throw new ApiError(400, 'unknown_template', `Unknown template ${slug}`);
  const p = t.params.find((x) => x.key === key);
  if (!p) throw new ApiError(400, 'unknown_param', `${t.name} has no parameter "${key}". Parameters: ${t.params.map((x) => x.key).join(', ')}`);
  const s = String(value);
  switch (p.type) {
    case 'number': { const n = Number(s); if (!Number.isFinite(n) || n < p.min || n > p.max) throw new ApiError(400, 'invalid_param', `${key} must be ${p.min}–${p.max}`); return String(Math.round(n)); }
    case 'choice': if (!p.options.some(([v]) => v === s)) throw new ApiError(400, 'invalid_param', `${key} must be one of ${p.options.map(([v]) => v).join(', ')}`); return s;
    case 'color': if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new ApiError(400, 'invalid_param', `${key} must be a color like #aabbcc`); return s.toLowerCase();
    case 'boolean': if (s !== 'true' && s !== 'false') throw new ApiError(400, 'invalid_param', `${key} must be true or false`); return s;
  }
}

/**
 * Closest template for a RoomPlan object: candidates by category, then the smallest relative size
 * difference (width, depth, height). An L-shaped sofa shows up in RoomPlan as one deep "sofa" box.
 */
export function matchTemplate(category: string, wIn: number, dIn: number, hIn: number) {
  let [w, d] = wIn >= dIn ? [wIn, dIn] : [dIn, wIn];
  const candidates = TEMPLATES.filter((t) => t.categories.includes(category));
  if (!candidates.length) return null;
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1);
  const scored = candidates.map((t) => {
    let score = rel(w, t.w) + rel(d, t.d) + 0.5 * rel(hIn, t.h);
    if (t.slug === 'l_sectional') score += w >= 90 && d >= 55 ? -0.5 : 1; // deep and wide = L
    if (t.slug === 'swivel_chair' && category === 'chair') score += 0.1;
    return { t, score };
  }).sort((a, b) => a.score - b.score);
  const best = scored[0].t;
  const params: Record<string, string> = {};
  if (best.slug === 'l_sectional') params.chaiseDepthIn = String(Math.max(40, Math.min(120, d)));
  if (best.slug === 'sofa' || best.slug === 'l_sectional') params.cushionCount = String(Math.max(1, Math.min(6, Math.round(w / 30))));
  return { slug: best.slug, name: best.name, score: Math.round(scored[0].score * 100) / 100, params, wIn: w, dIn: d, hIn };
}
