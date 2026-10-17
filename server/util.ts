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

const rank = { manual_estimate: 0, measured: 1, scan: 1, manual: 2 } as const;
export type Source = keyof typeof rank;

/** Lowest-confidence source among fields (drives the "rough" badge). */
export function weakestSource(sources: Source[]): Source {
  if (sources.includes('manual_estimate')) return 'manual_estimate';
  if (sources.includes('scan')) return 'scan';
  if (sources.includes('measured')) return 'measured';
  return 'manual';
}

export type MeasurementRow = {
  field: string; valueIn: number; source: Source; isOverride: boolean; recordedAt: Date; id: number; unpinnedAt?: Date | null;
};
/** A pin is a manual override that hasn't been released. */
export const isPin = (m: MeasurementRow) => m.isOverride && m.source === 'manual' && !m.unpinnedAt;

/**
 * Effective value per field: newest active pin/override > newest of measured/scan/manual > newest manual_estimate.
 * Scans and estimates can never beat an active pin.
 */
export function effective(ms: MeasurementRow[]) {
  const byField = new Map<string, MeasurementRow[]>();
  for (const m of ms) byField.set(m.field, [...(byField.get(m.field) ?? []), m]);
  const out: Record<string, { valueIn: number; source: Source; override: boolean; pinned: boolean; history: number }> = {};
  for (const [field, list] of byField) {
    const newest = (xs: MeasurementRow[]) => [...xs].sort((a, b) => +b.recordedAt - +a.recordedAt || b.id - a.id)[0];
    const pick =
      newest(list.filter((m) => m.isOverride && !m.unpinnedAt)) ??
      newest(list.filter((m) => m.source !== 'manual_estimate')) ??
      newest(list);
    out[field] = { valueIn: pick.valueIn, source: pick.source, override: pick.isOverride && !pick.unpinnedAt, pinned: isPin(pick), history: list.length };
  }
  return out;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
