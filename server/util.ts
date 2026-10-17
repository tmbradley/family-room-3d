import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Human-friendly code like "K7QF-9MZD-2HWX" (no 0/O/1/I). */
export function humanCode(groups = 3, len = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    const b = randomBytes(len);
    for (let i = 0; i < len; i++) s += alphabet[b[i] % alphabet.length];
    out.push(s);
  }
  return out.join('-');
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const rank = { manual_estimate: 0, measured: 1, scan: 1 } as const;
export type Source = keyof typeof rank;

/** Lowest-confidence source among fields (drives the "rough" badge). */
export function weakestSource(sources: Source[]): Source {
  if (sources.includes('manual_estimate')) return 'manual_estimate';
  if (sources.includes('scan')) return 'scan';
  return 'measured';
}

type M = { field: string; valueIn: number; source: Source; isOverride: boolean; recordedAt: Date; id: number };
/** Effective value per field: newest override > newest of scan/measured > newest manual_estimate. */
export function effective(ms: M[]) {
  const byField = new Map<string, M[]>();
  for (const m of ms) byField.set(m.field, [...(byField.get(m.field) ?? []), m]);
  const out: Record<string, { valueIn: number; source: Source; override: boolean; history: number }> = {};
  for (const [field, list] of byField) {
    const newest = (xs: M[]) => xs.sort((a, b) => +b.recordedAt - +a.recordedAt || b.id - a.id)[0];
    const pick =
      newest(list.filter((m) => m.isOverride)) ??
      newest(list.filter((m) => m.source !== 'manual_estimate')) ??
      newest(list);
    out[field] = { valueIn: pick.valueIn, source: pick.source, override: pick.isOverride, history: list.length };
  }
  return out;
}
