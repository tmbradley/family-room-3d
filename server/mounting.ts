/**
 * Hanging a piece on a wall: from a wall and a distance along it, the room position (inches, the
 * piece's center, its back against the wall face) and the turn that faces it into the room.
 * Same frame as the editor: room-local x/y, rotationDeg 0 = the piece faces -y.
 */
import type { Tx } from './entities.js';
import { ApiError } from './util.js';

export function poseOnWall(
  walls: { id: number; startXIn: number; startYIn: number; endXIn: number; endYIn: number }[],
  wallId: number, offsetIn: number, depthIn: number,
) {
  const w = walls.find((x) => x.id === wallId);
  if (!w) throw new ApiError(400, 'invalid_ref', `wall ${wallId} isn't in that room`);
  const dx = w.endXIn - w.startXIn, dy = w.endYIn - w.startYIn, L = Math.hypot(dx, dy);
  if (L < 1) throw new ApiError(400, 'invalid_ref', `wall ${wallId} has no length`);
  if (offsetIn < 0 || offsetIn > L) throw new ApiError(400, 'invalid_value', `offsetIn must be 0–${Math.round(L)} (the wall is ${Math.round(L)}in long)`);
  const ux = dx / L, uy = dy / L;
  // Inward normal: toward the middle of the room's walls.
  const xs = walls.flatMap((x) => [x.startXIn, x.endXIn]), ys = walls.flatMap((x) => [x.startYIn, x.endYIn]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  let nx = -uy, ny = ux;
  const mx = w.startXIn + ux * offsetIn, my = w.startYIn + uy * offsetIn;
  if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
  const xIn = Math.round(mx + nx * (depthIn / 2)), yIn = Math.round(my + ny * (depthIn / 2));
  const deg = (Math.round((Math.atan2(nx, -ny) * 180) / Math.PI) + 360) % 360;
  return { xIn, yIn, rotationDeg: deg };
}

export async function poseOnWallOf(tx: Tx, roomId: number, wallId: number, offsetIn: number, depthIn: number) {
  const walls = await tx.wall.findMany({ where: { roomId } });
  return poseOnWall(walls, wallId, offsetIn, depthIn);
}
