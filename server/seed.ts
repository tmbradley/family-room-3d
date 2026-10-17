/**
 * Seed the database from tmbradley/house-data house.json (feet -> integer inches).
 * Room structure comes in as `measured`; window sill/head, fixture positions and
 * furniture sizes/positions come in as `manual_estimate`. Recorded as revision 1 (kind=seed).
 */
import { Prisma, PrismaClient } from '@prisma/client';

const ft = (v: number) => Math.round(v * 12);
type Src = 'manual_estimate' | 'measured' | 'scan';

export async function seedHouse(prisma: PrismaClient, src: any, force = false) {
  if ((await prisma.house.count()) > 0 && !force) {
    return 'Database already has a house; pass --force to wipe house data and reseed.';
  }
  return prisma.$transaction(async (tx) => {
    if (force) {
      await tx.revisionChange.deleteMany();
      await tx.revision.deleteMany();
      await tx.measurement.deleteMany();
      await tx.placement.deleteMany();
      await tx.furnitureItem.deleteMany();
      await tx.house.deleteMany();
    }
    const changes: Prisma.RevisionChangeCreateManyInput[] = [];
    const measurements: Prisma.MeasurementCreateManyInput[] = [];
    let seq = 0;
    const record = (entityType: string, entityId: number, data: Record<string, unknown>) => {
      changes.push({ revisionId: 0, seq: seq++, op: 'create', entityType, entityId });
      for (const [field, v] of Object.entries(data)) {
        if (v === undefined || v === null) continue;
        changes.push({ revisionId: 0, seq: seq++, op: 'create', entityType, entityId, field, afterValue: String(v) });
      }
    };
    const measure = (entityType: string, entityId: number, fields: Record<string, number | null | undefined>, source: Src, note?: string) => {
      for (const [field, valueIn] of Object.entries(fields)) {
        if (valueIn === undefined || valueIn === null) continue;
        measurements.push({ entityType, entityId, field, valueIn, source, recordedBy: 'system', note: note ?? 'seed from house-data/house.json' });
      }
    };

    const houseData = { name: src.house?.name ?? 'House' };
    const house = await tx.house.create({ data: houseData });
    record('house', house.id, houseData);

    for (const r of src.current.rooms) {
      const roomData = {
        houseId: house.id, slug: r.id, label: r.label,
        originXIn: ft(r.origin?.x ?? 0), originYIn: ft(r.origin?.z ?? 0), rotationDeg: r.rotation ?? 0,
        ceilingIn: ft(r.ceiling),
        floorMaterial: r.floor?.material, floorFinish: r.floor?.finish, floorColor: r.floor?.color, floorKeep: !!r.floor?.keep,
        wallColorName: r.wallColor?.name, wallColor: r.wallColor?.color,
        trimColorName: r.trimColor?.name, trimColor: r.trimColor?.color,
        measurementStatus: 'measured' as const,
      };
      const room = await tx.room.create({ data: roomData });
      record('room', room.id, roomData);
      measure('room', room.id, { ceilingIn: roomData.ceilingIn }, 'measured');

      const wallIds = new Map<string, number>();
      const walls = [
        ...r.walls.map((w: any) => ({ ...w, isOpen: false })),
        ...(r.openEdges ?? []).map((e: any) => ({ ...e, isOpen: true, height: r.ceiling })),
      ];
      for (const w of walls) {
        const wallData = {
          roomId: room.id, label: w.id, startXIn: ft(w.a[0]), startYIn: ft(w.a[1]), endXIn: ft(w.b[0]), endYIn: ft(w.b[1]),
          heightIn: ft(w.height), isOpen: w.isOpen, openTo: w.to, notes: w.note, measurementStatus: 'measured' as const,
        };
        const wall = await tx.wall.create({ data: wallData });
        wallIds.set(w.id, wall.id);
        record('wall', wall.id, wallData);
        measure('wall', wall.id, { startXIn: wallData.startXIn, startYIn: wallData.startYIn, endXIn: wallData.endXIn, endYIn: wallData.endYIn, heightIn: wallData.heightIn }, 'measured');
      }

      for (const o of r.openings ?? []) {
        const hasEstimates = o.sill != null || o.head != null;
        const openingData = {
          wallId: wallIds.get(o.wall)!, label: o.id, type: o.type as 'window' | 'fireplace' | 'door' | 'open_span',
          offsetIn: ft(o.offset), widthIn: ft(o.width),
          sillIn: o.sill != null ? ft(o.sill) : undefined, headIn: o.head != null ? ft(o.head) : undefined,
          flush: !!o.flush, treatment: o.treatment, notes: o.note,
          measurementStatus: (hasEstimates ? 'manual_estimate' : 'measured') as Src,
        };
        const op = await tx.opening.create({ data: openingData });
        record('opening', op.id, openingData);
        measure('opening', op.id, { offsetIn: openingData.offsetIn, widthIn: openingData.widthIn }, 'measured');
        measure('opening', op.id, { sillIn: openingData.sillIn, headIn: openingData.headIn }, 'manual_estimate');
      }

      const fixtureType: Record<string, 'ceiling_fan' | 'window_treatment' | 'outlet' | 'other'> = {
        ceilingFan: 'ceiling_fan', windowTreatment: 'window_treatment', electrical: 'outlet',
      };
      for (const f of r.fixtures ?? []) {
        const opening = f.opening ? (r.openings ?? []).find((o: any) => o.id === f.opening) : undefined;
        const fixtureData = {
          roomId: room.id, type: fixtureType[f.type] ?? 'other', name: f.name, color: f.color,
          xIn: f.x != null ? ft(f.x) : undefined, yIn: f.z != null ? ft(f.z) : undefined,
          wallId: opening ? wallIds.get(opening.wall) : undefined, notes: f.note, measurementStatus: 'manual_estimate' as const,
        };
        const fx = await tx.fixture.create({ data: fixtureData });
        record('fixture', fx.id, fixtureData);
        measure('fixture', fx.id, { xIn: fixtureData.xIn, yIn: fixtureData.yIn }, 'manual_estimate', 'estimated from photos');
      }

      for (const p of r.furniture ?? []) {
        const itemData = {
          slug: `existing-${r.id}-${p.id}`, kind: p.kind, name: p.name, wIn: p.w, dIn: p.d, hIn: p.h,
          color: p.color, accentColor: p.accent, status: 'existing' as const, notes: p.note, measurementStatus: 'manual_estimate' as const,
        };
        const item = await tx.furnitureItem.create({ data: itemData });
        record('furniture_item', item.id, itemData);
        measure('furniture_item', item.id, { wIn: p.w, dIn: p.d, hIn: p.h }, 'manual_estimate', 'estimated from photos');
        const placementData = {
          roomId: room.id, itemId: item.id, xIn: ft(p.x), yIn: ft(p.z), rotationDeg: p.rot ?? 0,
          action: 'existing' as const, measurementStatus: 'manual_estimate' as const,
        };
        const pl = await tx.placement.create({ data: placementData });
        record('placement', pl.id, placementData);
        measure('placement', pl.id, { xIn: placementData.xIn, yIn: placementData.yIn }, 'manual_estimate', 'estimated from photos');
      }
    }

    const rev = await tx.revision.create({
      data: { houseId: house.id, scope: 'current', number: 1, actor: 'system', kind: 'seed', note: 'Seed from tmbradley/house-data house.json' },
    });
    await tx.revisionChange.createMany({ data: changes.map((c) => ({ ...c, revisionId: rev.id })) });
    await tx.measurement.createMany({ data: measurements });
    await tx.house.update({ where: { id: house.id }, data: { currentRevision: 1 } });
    return `Seeded house ${house.id}: ${changes.length} revision change rows, ${measurements.length} measurements.`;
  }, { timeout: 60_000 });
}
