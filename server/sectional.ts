/**
 * RoomPlan reports an L-shaped sectional as separate "sofa" boxes (the run, the chaise, an attached
 * ottoman). mergeSectionals finds groups of sofa boxes that touch or overlap and form an L, and turns
 * each into one l_sectional piece with its chaise (side, length, width) and ottoman (side, size).
 * Pure geometry on plan coordinates (inches, +y = plan y); no database.
 *
 * Conventions (same as the editor and the l_sectional template): a placement's xIn/yIn is the center
 * of its footprint; rotation θ turns local right (+x) to plan (cosθ, sinθ) and local front (+z, the
 * side you sit facing) to plan (sinθ, -cosθ). The back of the run is at local -z.
 */
import type { ParsedObject } from './scans.js';

export type Box = { x0: number; x1: number; y0: number; y1: number };
export type MergedSectional = {
  keys: string[]; // the scanned objects it replaces
  xIn: number; yIn: number; rotationDeg: number; widthIn: number; depthIn: number; heightIn: number;
  params: Record<string, string>;
  name: string; notes: string;
};

const TOUCH_IN = 4; // boxes this close count as attached
const END_SLACK_IN = 10; // chaise/ottoman outer edge must be this close to an end of the run
const MIN_CHAISE_IN = 20; // how far a chaise must stick out from the front of the run
const OTTOMAN_MAX_IN = 48;

const sq = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
/** Plan footprint of a scanned object (rotation squared to 90°). */
export function footprint(o: Pick<ParsedObject, 'xIn' | 'yIn' | 'rotationDeg' | 'widthIn' | 'depthIn'>): Box {
  const along = sq(o.rotationDeg) % 180 === 0;
  const ex = (along ? o.widthIn : o.depthIn) / 2, ey = (along ? o.depthIn : o.widthIn) / 2;
  return { x0: o.xIn - ex, x1: o.xIn + ex, y0: o.yIn - ey, y1: o.yIn + ey };
}
/** Overlapping, or apart by at most TOUCH_IN on one axis while overlapping on the other. */
const touches = (a: Box, b: Box) => {
  const gx = Math.max(a.x0 - b.x1, b.x0 - a.x1), gy = Math.max(a.y0 - b.y1, b.y0 - a.y1);
  return Math.max(gx, gy) <= TOUCH_IN && Math.min(gx, gy) < 0;
};

type Piece = { o: ParsedObject; b: Box };
// Run axis 'x': the run lies along plan x, and depth is along y.
const along = (b: Box, ax: 'x' | 'y') => (ax === 'x' ? [b.x0, b.x1] : [b.y0, b.y1]) as [number, number];
const across = (b: Box, ax: 'x' | 'y') => (ax === 'x' ? [b.y0, b.y1] : [b.x0, b.x1]) as [number, number];
const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/** Try to read one group of touching sofa boxes as an L-sectional. Null when it isn't one. */
export function asSectional(pieces: Piece[]): Omit<MergedSectional, 'name' | 'notes'> & { ottoman: boolean } | null {
  if (pieces.length < 2) return null;
  const len = (p: Piece) => Math.max(p.b.x1 - p.b.x0, p.b.y1 - p.b.y0);
  const main = [...pieces].sort((a, b) => len(b) - len(a))[0];
  const ax: 'x' | 'y' = main.b.x1 - main.b.x0 >= main.b.y1 - main.b.y0 ? 'x' : 'y';
  // The run: the main box plus any box in line with it (same depth band).
  let run = along(main.b, ax), band = across(main.b, ax);
  const rest: Piece[] = [];
  for (const p of pieces) {
    if (p === main) continue;
    const a = across(p.b, ax);
    if (overlap(a, band) >= 0.6 * Math.min(a[1] - a[0], band[1] - band[0])) { run = [Math.min(run[0], along(p.b, ax)[0]), Math.max(run[1], along(p.b, ax)[1])]; band = [Math.min(band[0], a[0]), Math.max(band[1], a[1])]; }
    else rest.push(p);
  }
  if (!rest.length) return null; // a straight sofa, not an L
  // Every other box must stick out on the same side of the run: that side is the front.
  const mid = (band[0] + band[1]) / 2;
  const sides = rest.map((p) => (across(p.b, ax)[0] + across(p.b, ax)[1]) / 2 < mid ? -1 : 1);
  if (sides.some((s) => s !== sides[0])) return null;
  const front = sides[0]; // -1: toward smaller plan coordinate
  const runFront = front < 0 ? band[0] : band[1];
  const stickOut = (p: Piece) => (front < 0 ? runFront - across(p.b, ax)[0] : across(p.b, ax)[1] - runFront);
  const atEnd = (p: Piece) => { const s = along(p.b, ax); return Math.min(Math.abs(s[0] - run[0]), Math.abs(s[1] - run[1])) <= END_SLACK_IN; };
  if (rest.some((p) => !atEnd(p))) return null;
  const sorted = [...rest].sort((a, b) => stickOut(b) - stickOut(a));
  const chaise = sorted[0];
  if (stickOut(chaise) < MIN_CHAISE_IN) return null;
  const others = sorted.slice(1);
  if (others.length > 1) return null; // one chaise and at most one attached ottoman
  const ott = others[0];
  if (ott && (ott.b.x1 - ott.b.x0 > OTTOMAN_MAX_IN || ott.b.y1 - ott.b.y0 > OTTOMAN_MAX_IN)) return null;
  const endOf = (p: Piece) => { const s = along(p.b, ax); return Math.abs(s[0] - run[0]) <= Math.abs(s[1] - run[1]) ? 0 : 1; };
  if (ott && endOf(ott) === endOf(chaise)) return null; // both at the same end: not a shape the template draws

  // Union footprint and orientation.
  const all = pieces.map((p) => p.b);
  const U = { x0: Math.min(...all.map((b) => b.x0)), x1: Math.max(...all.map((b) => b.x1)), y0: Math.min(...all.map((b) => b.y0)), y1: Math.max(...all.map((b) => b.y1)) };
  const f = ax === 'x' ? { x: 0, y: front } : { x: front, y: 0 }; // plan direction of the front
  const rotationDeg = ((Math.round(Math.atan2(f.x, -f.y) * 180 / Math.PI) % 360) + 360) % 360;
  const r = { x: -f.y, y: f.x }; // plan direction of local right
  const cx = (U.x0 + U.x1) / 2, cy = (U.y0 + U.y1) / 2;
  const ext = (b: Box, v: { x: number; y: number }) => Math.abs(v.x) * (b.x1 - b.x0) + Math.abs(v.y) * (b.y1 - b.y0);
  const ctr = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const sideOf = (b: Box) => ((ctr(b).x - cx) * r.x + (ctr(b).y - cy) * r.y >= 0 ? 'right' : 'left');
  const widthIn = Math.round(ext(U, r)), depthIn = Math.round(ext(U, f));
  const runDepth = band[1] - band[0];
  const chaiseW = ext(chaise.b, r);
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  const params: Record<string, string> = {
    chaiseSide: sideOf(chaise.b),
    chaiseDepthIn: String(clamp(runDepth + stickOut(chaise), 40, 120)),
    chaiseWidthIn: String(clamp(chaiseW, 20, 80)),
    seatDepthIn: String(clamp(runDepth - 11, 16, 36)),
    cushionCount: String(clamp((widthIn - chaiseW) / 30, 1, 6)), // seats along the run, beside the chaise
    ottomanSide: ott ? sideOf(ott.b) : 'none',
  };
  if (ott) { params.ottomanWidthIn = String(clamp(ext(ott.b, r), 12, 80)); params.ottomanDepthIn = String(clamp(stickOut(ott), 12, 60)); }
  return {
    keys: pieces.map((p) => p.o.key), xIn: Math.round(cx), yIn: Math.round(cy), rotationDeg, widthIn, depthIn,
    heightIn: Math.max(...pieces.map((p) => p.o.heightIn)), params, ottoman: !!ott,
  };
}

/** Group touching sofa boxes and merge each group that forms an L. Returns the merged pieces and the objects left as they were. */
export function mergeSectionals(objects: ParsedObject[]): { merged: MergedSectional[]; rest: ParsedObject[] } {
  const sofas = objects.filter((o) => o.kind === 'sofa').map((o) => ({ o, b: footprint(o) }));
  const groups: Piece[][] = [];
  const seen = new Set<Piece>();
  for (const s of sofas) {
    if (seen.has(s)) continue;
    const g: Piece[] = [s]; seen.add(s);
    for (let i = 0; i < g.length; i++) for (const t of sofas) if (!seen.has(t) && touches(g[i].b, t.b)) { seen.add(t); g.push(t); }
    groups.push(g);
  }
  const merged: MergedSectional[] = [];
  const used = new Set<string>();
  for (const g of groups) {
    const m = asSectional(g);
    if (!m) continue;
    const { ottoman, ...rest } = m;
    m.keys.forEach((k) => used.add(k));
    merged.push({
      ...rest,
      name: `L-sectional${ottoman ? ' with ottoman' : ''} (scanned, ${g.length} pieces)`,
      notes: `Merged from ${g.length} scanned "sofa" boxes: ${g.map((p) => `${p.o.widthIn}x${p.o.depthIn}`).join(', ')}`,
    });
  }
  return { merged, rest: objects.filter((o) => !used.has(o.key)) };
}
