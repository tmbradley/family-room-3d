// Builds synthetic rooms in Apple RoomPlan's CapturedRoom Codable layout (what
// JSONEncoder().encode(capturedRoom) produces on iOS 17): keyed-enum categories, simd_float3
// dimensions [x, y(up), z] in meters, column-major 4x4 transforms, parentIdentifier on doors,
// windows and openings. Used for the sample fixture and the tests. These are NOT device captures.
const IN = 0.0254;
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * @param {object} o
 * @param {number} [o.yawDeg=30] world rotation of the whole room (RoomPlan's frame starts wherever the phone was)
 * @param {{x:number,z:number}} [o.origin] world offset in meters
 * @param {number} [o.floorY=-1.2] floor height in meters relative to the session origin
 * @param {number} [o.heightIn=108]
 * @param {number[][]} o.walls plan walls [ax, az, bx, bz] in inches (x right, z = plan y, seen from above;
 *   RoomPlan's world is right-handed with y up, so plan y runs along world -Z)
 * @param {{wall:number, offsetIn:number, widthIn:number, heightIn:number, sillIn?:number, n?:number}[]} [o.doors]
 * @param {typeof o.doors} [o.windows]
 * @param {typeof o.doors} [o.openings]
 * @param {{cat:string, x:number, z:number, w:number, h:number, d:number}[]} [o.objects]
 * @param {boolean} [o.parents=true] include parentIdentifier (iOS 17+)
 */
export function buildCapturedRoom(o) {
  const phi = ((o.yawDeg ?? 30) * Math.PI) / 180, T = o.origin ?? { x: 1.3, z: -0.4 }, floorY = o.floorY ?? -1.2, H = (o.heightIn ?? 108) * IN;
  // Plan (x, y) -> world (x, -y), then the session's yaw and offset.
  const world = (x, py) => { const z = -py; return { x: x * Math.cos(phi) - z * Math.sin(phi) + T.x, z: x * Math.sin(phi) + z * Math.cos(phi) + T.z }; };
  const dirW = (dx, dpy) => { const dz = -dpy; return { x: dx * Math.cos(phi) - dz * Math.sin(phi), z: dx * Math.sin(phi) + dz * Math.cos(phi) }; };
  const transform = (d, p, y) => [d.x, 0, d.z, 0, 0, 1, 0, 0, -d.z, 0, d.x, 0, p.x, y, p.z, 1];
  const base = (id, category) => ({ identifier: id, category, confidence: { high: {} }, completedEdges: [], polygonCorners: [], story: 0, curve: null });
  const wallIds = o.walls.map((_, i) => o.wallIds?.[i] ?? uuid(i + 1));
  const walls = o.walls.map(([ax, az, bx, bz], i) => {
    const len = Math.hypot(bx - ax, bz - az), d = dirW((bx - ax) / len, (bz - az) / len), c = world(((ax + bx) / 2) * IN, ((az + bz) / 2) * IN);
    return { ...base(wallIds[i], { wall: {} }), parentIdentifier: null, dimensions: [len * IN, H, 0], transform: transform(d, c, floorY + H / 2) };
  });
  let n = 100;
  const onWall = (category) => (s) => {
    const [ax, az, bx, bz] = o.walls[s.wall], len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
    const t = s.offsetIn + s.widthIn / 2, c = world((ax + ux * t) * IN, (az + uz * t) * IN), sill = s.sillIn ?? 0;
    return {
      ...base(uuid(s.n ?? n++), typeof category === 'function' ? category(s) : category), parentIdentifier: o.parents === false ? null : wallIds[s.wall],
      dimensions: [s.widthIn * IN, s.heightIn * IN, 0], transform: transform(dirW(ux, uz), c, floorY + (sill + s.heightIn / 2) * IN),
    };
  };
  const xs = o.walls.flatMap((w) => [w[0], w[2]]), zs = o.walls.flatMap((w) => [w[1], w[3]]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2, fc = world(cx * IN, cz * IN);
  return {
    identifier: uuid(999), story: 0, version: 2,
    sections: [{ label: { livingRoom: {} }, center: [fc.x, floorY, fc.z], story: 0 }],
    walls,
    doors: (o.doors ?? []).map(onWall(() => ({ door: { isOpen: false } }))),
    windows: (o.windows ?? []).map(onWall({ window: {} })),
    openings: (o.openings ?? []).map(onWall({ opening: {} })),
    floors: [{ ...base(uuid(998), { floor: {} }), parentIdentifier: null, dimensions: [(Math.max(...xs) - Math.min(...xs)) * IN, (Math.max(...zs) - Math.min(...zs)) * IN, 0],
      transform: [Math.cos(phi), 0, Math.sin(phi), 0, -Math.sin(phi), 0, Math.cos(phi), 0, 0, -1, 0, 0, fc.x, floorY, fc.z, 1] }],
    objects: (o.objects ?? []).map((b) => {
      const c = world(b.x * IN, b.z * IN);
      return { identifier: uuid(n++), parentIdentifier: null, category: { [b.cat]: {} }, confidence: { medium: {} }, attributes: {}, story: 0, dimensions: [b.w * IN, b.h * IN, b.d * IN], transform: transform(dirW(1, 0), c, floorY + (b.h / 2) * IN) };
    }),
  };
}

/** The sample family room: 12' x 13', 9' ceiling, a window, a door and an open span. */
export const SAMPLE = {
  walls: [[0, 0, 144, 0], [144, 0, 144, 156], [144, 156, 0, 156], [0, 156, 0, 0]],
  doors: [{ wall: 3, offsetIn: 24, widthIn: 36, heightIn: 80, n: 11 }],
  windows: [{ wall: 0, offsetIn: 42, widthIn: 60, heightIn: 48, sillIn: 36, n: 12 }],
  openings: [{ wall: 1, offsetIn: 40, widthIn: 72, heightIn: 84, n: 13 }],
  objects: [{ cat: 'sofa', x: 72, z: 120, w: 84, h: 34, d: 36 }, { cat: 'table', x: 72, z: 78, w: 48, h: 18, d: 24 }],
};
