/**
 * Designs (workspaces) as the editor's sidebar shows them: unique names per room, archive/restore,
 * where each design came from, and the "Save to Current" summary.
 *
 * Names are unique per room among live (not archived) designs, case-insensitively. A design's rooms
 * are the Current rooms it links plus its own draft rooms (draft rooms compare by label).
 */
import { ApiError } from './util.js';
import type { Tx } from './entities.js';

export const clean = (name: string) => name.replace(/\s+/g, ' ').trim();
const norm = (name: string) => clean(name).toLowerCase();

/** Keys of the rooms a design is about: "r:<id>" for linked Current rooms, "l:<label>" for draft rooms. */
export async function roomKeysOf(tx: Tx, workspaceId: number) {
  const [links, drafts] = await Promise.all([
    tx.workspaceRoom.findMany({ where: { workspaceId }, include: { room: { select: { id: true, label: true, draftWorkspaceId: true } } } }),
    tx.room.findMany({ where: { draftWorkspaceId: workspaceId }, select: { id: true, label: true } }),
  ]);
  const keys = new Set<string>(), labels = new Set<string>();
  for (const l of links) { if (l.room.draftWorkspaceId == null) keys.add(`r:${l.room.id}`); else keys.add(`l:${l.room.label.toLowerCase()}`); labels.add(l.room.label); }
  for (const r of drafts) { keys.add(`l:${r.label.toLowerCase()}`); labels.add(r.label); }
  return { keys: [...keys], labels: [...labels] };
}

/** Current room keys (a new design on Current links all of them). */
export async function currentRoomKeys(tx: Tx, houseId: number) {
  const rooms = await tx.room.findMany({ where: { houseId, draftWorkspaceId: null }, select: { id: true, label: true }, orderBy: { id: 'asc' } });
  return { keys: rooms.map((r) => `r:${r.id}`), labels: rooms.map((r) => r.label) };
}

/** The live design that already uses this name in one of these rooms, if any. */
export async function nameClash(tx: Tx, houseId: number, name: string, keys: string[], exceptId?: number) {
  const want = norm(name);
  const others = await tx.workspace.findMany({ where: { houseId, archivedAt: null, ...(exceptId != null ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true } });
  const mine = new Set(keys);
  for (const o of others) {
    if (norm(o.name) !== want) continue;
    const theirs = (await roomKeysOf(tx, o.id)).keys;
    if ((!theirs.length && !mine.size) || theirs.some((k) => mine.has(k))) return o;
  }
  return null;
}

/** First free name: base, "base 2", "base 3", ... */
export async function uniqueName(tx: Tx, houseId: number, base: string, keys: string[], exceptId?: number) {
  const b = clean(base).slice(0, 112) || 'Design';
  for (let n = 1; n < 500; n++) {
    const name = n === 1 ? b : `${b} ${n}`;
    if (!(await nameClash(tx, houseId, name, keys, exceptId))) return name;
  }
  throw new ApiError(409, 'name_taken', 'Too many designs with this name');
}

/** 409 with a suggestion when the name is taken by another design in the same room. */
export async function assertNameFree(tx: Tx, houseId: number, name: string, keys: string[], labels: string[], exceptId?: number) {
  if (!clean(name)) throw new ApiError(400, 'invalid_name', 'A design needs a name');
  const o = await nameClash(tx, houseId, name, keys, exceptId);
  if (!o) return clean(name);
  const suggestion = await uniqueName(tx, houseId, name, keys, exceptId);
  throw new ApiError(409, 'name_taken', `That name is taken by another ${labels[0] ?? 'house'} design (${o.name}, #${o.id}). Try "${suggestion}".`, { suggestion, takenBy: o.id });
}

/** Archive or restore. Archived designs are read-only and hidden from the list; nothing is deleted. */
export async function setArchived(tx: Tx, workspaceId: number, archived: boolean) {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw new ApiError(404, 'workspace_not_found', `Workspace ${workspaceId} not found`);
  if (archived === (ws.archivedAt != null)) return { id: ws.id, archivedAt: ws.archivedAt, unchanged: true };
  if (archived) {
    const pending = await tx.proposal.count({ where: { status: 'pending', OR: [{ targetWorkspaceId: workspaceId }, { baseWorkspaceId: workspaceId }] } });
    if (pending) throw new ApiError(409, 'has_pending', `This design has ${pending} pending proposal(s). Approve or reject them first.`);
  } else {
    const { keys, labels } = await roomKeysOf(tx, workspaceId);
    await assertNameFree(tx, ws.houseId, ws.name, keys, labels, ws.id);
  }
  const row = await tx.workspace.update({ where: { id: workspaceId }, data: { archivedAt: archived ? new Date() : null } });
  return { id: row.id, archivedAt: row.archivedAt, unchanged: false };
}

/** 409 if a design is archived (it must be restored before it changes). */
export async function assertNotArchived(tx: Tx, workspaceId: number) {
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { archivedAt: true, name: true } });
  if (ws?.archivedAt) throw new ApiError(409, 'archived', `"${ws.name}" is archived. Restore it to change it.`);
}
