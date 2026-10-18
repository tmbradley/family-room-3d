/**
 * Registry of what a change (editor save, proposal, rollback) may touch, field by field.
 * Every change goes through server/changes.ts, which uses this to validate, coerce, and check
 * that the entity belongs to the workspace being changed.
 */
import type { Prisma } from '@prisma/client';
import { ApiError } from './util.js';

export type Tx = Prisma.TransactionClient;

export type FieldSpec =
  | { type: 'int'; nullable?: boolean; min?: number; max?: number; ref?: EntityType; system?: boolean }
  | { type: 'str'; nullable?: boolean; max: number; system?: boolean }
  | { type: 'bool'; system?: boolean }
  | { type: 'enum'; values: readonly string[]; nullable?: boolean; system?: boolean };

export type EntityType = 'placement' | 'furniture_item' | 'room' | 'wall' | 'opening' | 'fixture' | 'workspace';

const SRC = ['manual_estimate', 'measured', 'scan', 'manual'] as const;
const color = { type: 'str', nullable: true, max: 9 } as const;
const inches = (min = -100000, max = 100000) => ({ type: 'int', min, max }) as const;

type Def = {
  model: 'placement' | 'furnitureItem' | 'room' | 'wall' | 'opening' | 'fixture' | 'workspace';
  label: string;
  fields: Record<string, FieldSpec>;
  required: string[]; // for create
  create: boolean;
  delete: boolean;
  /** Fields that hold a measurement and can be pinned. */
  pinnable: string[];
};

export const ENTITIES: Record<EntityType, Def> = {
  placement: {
    model: 'placement', label: 'Furniture placement', create: true, delete: true, pinnable: [],
    required: ['roomId', 'itemId', 'xIn', 'yIn', 'action'],
    fields: {
      workspaceId: { type: 'int', nullable: true, system: true },
      roomId: { type: 'int', ref: 'room' },
      itemId: { type: 'int', ref: 'furniture_item' },
      xIn: inches(), yIn: inches(), rotationDeg: { type: 'int', min: 0, max: 359 },
      action: { type: 'enum', values: ['existing', 'keep', 'replace', 'remove', 'new'] },
      replacesPlacementId: { type: 'int', nullable: true, ref: 'placement' },
      notes: { type: 'str', nullable: true, max: 500 },
      measurementStatus: { type: 'enum', values: SRC, system: true },
    },
  },
  furniture_item: {
    model: 'furnitureItem', label: 'Furniture item (shared catalog)', create: true, delete: false, pinnable: ['wIn', 'dIn', 'hIn'],
    required: ['kind', 'name', 'wIn', 'dIn', 'hIn'],
    fields: {
      kind: { type: 'str', max: 40 }, name: { type: 'str', max: 160 },
      wIn: inches(1, 2000), dIn: inches(1, 2000), hIn: inches(0, 2000),
      color, accentColor: color,
      url: { type: 'str', nullable: true, max: 1000 }, imageUrl: { type: 'str', nullable: true, max: 1000 },
      priceCents: { type: 'int', nullable: true, min: 0, max: 100_000_000 },
      status: { type: 'enum', values: ['idea', 'shortlisted', 'bought', 'existing'] },
      notes: { type: 'str', nullable: true, max: 1000 },
      measurementStatus: { type: 'enum', values: SRC, system: true },
    },
  },
  room: {
    // Changes can only edit draft rooms. Current rooms are created/updated only by a promoted scan
    // (trusted internal caller) and by rollbacks of those revisions; see server/changes.ts.
    model: 'room', label: 'Room (draft rooms only)', create: false, delete: false, pinnable: ['ceilingIn'],
    required: ['houseId', 'slug', 'label', 'ceilingIn'],
    fields: {
      houseId: { type: 'int', system: true }, slug: { type: 'str', max: 60, system: true },
      draftWorkspaceId: { type: 'int', nullable: true, system: true },
      floorMaterial: { type: 'str', nullable: true, max: 80, system: true }, floorFinish: { type: 'str', nullable: true, max: 80, system: true },
      floorKeep: { type: 'bool', system: true },
      measurementStatus: { type: 'enum', values: SRC, system: true },
      label: { type: 'str', max: 120 }, ceilingIn: inches(1, 600),
      originXIn: inches(), originYIn: inches(), rotationDeg: { type: 'int', min: 0, max: 359 },
      floorColor: color, wallColorName: { type: 'str', nullable: true, max: 60 }, wallColor: color,
      trimColorName: { type: 'str', nullable: true, max: 60 }, trimColor: color,
    },
  },
  wall: {
    model: 'wall', label: 'Wall segment', create: true, delete: true, pinnable: ['startXIn', 'startYIn', 'endXIn', 'endYIn', 'heightIn', 'thicknessIn'],
    required: ['roomId', 'startXIn', 'startYIn', 'endXIn', 'endYIn', 'heightIn'],
    fields: {
      roomId: { type: 'int', ref: 'room' }, label: { type: 'str', nullable: true, max: 60 },
      startXIn: inches(), startYIn: inches(), endXIn: inches(), endYIn: inches(),
      heightIn: inches(0, 600), thicknessIn: inches(0, 48), isOpen: { type: 'bool' },
      openTo: { type: 'str', nullable: true, max: 80 }, notes: { type: 'str', nullable: true, max: 500 },
      measurementStatus: { type: 'enum', values: SRC, system: true },
    },
  },
  opening: {
    model: 'opening', label: 'Opening (window, door, fireplace, open span)', create: true, delete: true, pinnable: ['offsetIn', 'widthIn', 'sillIn', 'headIn'],
    required: ['wallId', 'type', 'offsetIn', 'widthIn'],
    fields: {
      wallId: { type: 'int', ref: 'wall' }, label: { type: 'str', nullable: true, max: 60 },
      type: { type: 'enum', values: ['window', 'door', 'open_span', 'fireplace'] },
      offsetIn: inches(0), widthIn: inches(1), sillIn: { type: 'int', nullable: true, min: 0, max: 600 },
      headIn: { type: 'int', nullable: true, min: 0, max: 600 }, flush: { type: 'bool' },
      treatment: { type: 'str', nullable: true, max: 120 }, notes: { type: 'str', nullable: true, max: 500 },
      measurementStatus: { type: 'enum', values: SRC, system: true },
    },
  },
  fixture: {
    model: 'fixture', label: 'Fixture (fan, light, outlet, ...)', create: true, delete: true, pinnable: ['xIn', 'yIn'],
    required: ['roomId', 'type', 'name'],
    fields: {
      roomId: { type: 'int', ref: 'room' }, wallId: { type: 'int', nullable: true, ref: 'wall' },
      type: { type: 'enum', values: ['ceiling_fan', 'light', 'outlet', 'switch', 'window_treatment', 'other'] },
      name: { type: 'str', max: 120 }, color,
      xIn: { type: 'int', nullable: true }, yIn: { type: 'int', nullable: true }, count: { type: 'int', min: 1, max: 100 },
      notes: { type: 'str', nullable: true, max: 500 },
      measurementStatus: { type: 'enum', values: SRC, system: true },
    },
  },
  workspace: {
    model: 'workspace', label: 'Workspace (name and notes)', create: false, delete: false, pinnable: [],
    required: [],
    fields: { name: { type: 'str', max: 120 }, notes: { type: 'str', nullable: true, max: 5000 } },
  },
};

export const ENTITY_TYPES = Object.keys(ENTITIES) as EntityType[];

export function def(entityType: string): Def {
  const d = (ENTITIES as Record<string, Def>)[entityType];
  if (!d) throw new ApiError(400, 'unknown_entity', `Unknown entity type "${entityType}". Allowed: ${ENTITY_TYPES.join(', ')}`);
  return d;
}

export function fieldSpec(entityType: string, field: string, allowSystem = false): FieldSpec {
  const f = def(entityType).fields[field];
  if (!f || (f.system && !allowSystem)) {
    const allowed = Object.entries(def(entityType).fields).filter(([, s]) => !s.system).map(([k]) => k);
    throw new ApiError(400, 'unknown_field', `Field "${field}" can't be changed on ${entityType}. Allowed: ${allowed.join(', ')}`);
  }
  return f;
}

/** Coerce an incoming value (JSON or stored string) to the column's type. */
export function coerce(entityType: string, field: string, v: unknown, allowSystem = false): unknown {
  const f = fieldSpec(entityType, field, allowSystem);
  const where = `${entityType}.${field}`;
  if (v === null || v === undefined || v === '') {
    if ((f as any).nullable) return null;
    if (f.type === 'str' && v === '') throw new ApiError(400, 'invalid_value', `${where} can't be empty`);
    throw new ApiError(400, 'invalid_value', `${where} can't be null`);
  }
  switch (f.type) {
    case 'int': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw new ApiError(400, 'invalid_value', `${where} must be a number`);
      const r = Math.round(n);
      if ((f.min != null && r < f.min) || (f.max != null && r > f.max)) throw new ApiError(400, 'invalid_value', `${where} out of range`);
      return r;
    }
    case 'str': {
      const s = String(v);
      if (s.length > f.max) throw new ApiError(400, 'invalid_value', `${where} is longer than ${f.max} characters`);
      return s;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === '1' || v === 1) return true;
      if (v === 'false' || v === '0' || v === 0) return false;
      throw new ApiError(400, 'invalid_value', `${where} must be true or false`);
    case 'enum':
      if (!f.values.includes(String(v))) throw new ApiError(400, 'invalid_value', `${where} must be one of ${f.values.join(', ')}`);
      return String(v);
  }
}

/** Stored form for proposal/revision change rows. */
export const ser = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export const delegate = (tx: Tx, entityType: string) => (tx as any)[def(entityType).model];

/** Which workspace an entity belongs to: a number, 'global' (shared catalog), or null (Current). */
export async function ownerOf(tx: Tx, entityType: string, row: any): Promise<number | 'global' | null> {
  switch (entityType) {
    case 'placement': return row.workspaceId;
    case 'furniture_item': return 'global';
    case 'workspace': return row.id;
    case 'room': return row.draftWorkspaceId;
    case 'wall':
    case 'fixture': {
      const room = await tx.room.findUnique({ where: { id: row.roomId }, select: { draftWorkspaceId: true } });
      return room?.draftWorkspaceId ?? null;
    }
    case 'opening': {
      const wall = await tx.wall.findUnique({ where: { id: row.wallId }, select: { room: { select: { draftWorkspaceId: true } } } });
      return wall?.room.draftWorkspaceId ?? null;
    }
  }
  return null;
}

/** Room ids a workspace covers: its draft rooms plus linked Current rooms. */
export async function workspaceRoomIds(tx: Tx, workspaceId: number) {
  const [draft, linked] = await Promise.all([
    tx.room.findMany({ where: { draftWorkspaceId: workspaceId }, select: { id: true } }),
    tx.workspaceRoom.findMany({ where: { workspaceId }, select: { roomId: true } }),
  ]);
  return new Set([...draft.map((r) => r.id), ...linked.map((r) => r.roomId)]);
}

/** Human-readable field reference for agents (MCP tool descriptions). */
export function fieldReference() {
  return ENTITY_TYPES.map((t) => {
    const d = ENTITIES[t];
    const ops = ['update', d.create && 'create', d.delete && 'delete'].filter(Boolean).join('/');
    const fields = Object.entries(d.fields)
      .filter(([, f]) => !f.system)
      .map(([k, f]) => `${k}:${f.type === 'enum' ? f.values.join('|') : f.type}${(f as any).nullable ? '?' : ''}`)
      .join(', ');
    return `- ${t} (${d.label}; ${ops}): ${fields}`;
  }).join('\n');
}
