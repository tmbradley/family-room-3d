/**
 * MCP server at /mcp (Streamable HTTP, stateless, JSON responses).
 * Auth: "Authorization: Bearer <agent key>". Keys are stored hashed and scoped read/propose/admin.
 * Agents can read and propose. Nothing here applies a change: approval happens only in the
 * editor, signed in as Michael.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { prisma } from './db.js';
import { sha256, ApiError } from './util.js';
import { fieldReference } from './entities.js';
import { getHistory } from './changes.js';
import { getRoomView, getWorkspaceView, listWorkspaces } from './workspaces.js';
import { createProposal, listProposals, getProposal, proposalShape } from './proposals.js';
import { listPhotos } from './photos.js';
import { getScanImport } from './scans.js';
import { listTemplates, templateBySlug } from './templates.js';

type Scope = 'read' | 'propose' | 'admin';
const rank: Record<Scope, number> = { read: 0, propose: 1, admin: 2 };

const INSTRUCTIONS = `House planner for Michael Bradley's house. Lengths are integer inches; room x/y are plan coordinates.
"Current" is the house as it is now: structure from scans, plus the existing furniture and room colors. It is
locked: structure changes through promoted scans, measurements and rollbacks; furniture and colors only through
proposals for Current (current: true) that Michael approves. Designs live in workspaces, which link Current rooms,
start from Current's furniture and colors, and change them freely.
Photos from the iPhone are in list_room_photos (signed URLs valid a few minutes; call again for fresh ones).
You can read and propose. You can never change a design directly: create_proposal records a pending
change request that Michael approves or rejects in the editor. Every proposal needs a rationale, its
source (e.g. the X post URL), and a step-by-step low/high cost in USD. Pinned measurements can't be changed.`;

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

function buildServer(scope: Scope, agentKeyId: number) {
  const server = new McpServer({ name: 'house-planner', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const guard = async <T>(fn: () => Promise<T>) => {
    try { return json(await fn()); } catch (e: any) {
      const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : e?.issues ? `invalid_input: ${JSON.stringify(e.issues)}` : String(e?.message ?? e);
      return { isError: true, content: [{ type: 'text' as const, text: msg }] };
    }
  };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('list_workspaces', { title: 'List workspaces', description: 'All design workspaces with revision, room/placement counts and pending proposals.', annotations: ro },
    () => guard(() => listWorkspaces(prisma)));
  server.registerTool('get_workspace', {
    title: 'Get workspace', description: 'One workspace in full: rooms, walls, openings, fixtures, furniture placements and items, with measurement sources and pins.',
    inputSchema: { workspaceId: z.number().int() }, annotations: ro,
  }, ({ workspaceId }) => guard(() => getWorkspaceView(prisma, workspaceId)));
  server.registerTool('get_room', {
    title: 'Get room', description: 'One room with walls, openings, fixtures, furniture placements and colors: of a workspace, or of Current (the house as it is now) when workspaceId is omitted for a Current room. With measurement sources.',
    inputSchema: { roomId: z.number().int(), workspaceId: z.number().int().optional() }, annotations: ro,
  }, ({ roomId, workspaceId }) => guard(() => getRoomView(prisma, roomId, workspaceId)));
  server.registerTool('list_proposals', {
    title: 'List proposals', description: 'Proposals (newest first) with target, rooms, field-level changes (before/after), rationale, source and cost steps. Pass proposalId for one.',
    inputSchema: {
      status: z.enum(['pending', 'approved', 'rejected']).optional(), workspaceId: z.number().int().optional(), current: z.boolean().optional().describe('Only proposals for Current'),
      proposalId: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional(),
    }, annotations: ro,
  }, (a) => guard(async () => (a.proposalId != null ? [await getProposal(a.proposalId)] : listProposals(a))));
  server.registerTool('get_history', {
    title: 'Get history', description: 'Append-only revision history of a workspace, or of Current when workspaceId is omitted (newest first), with field-level changes.',
    inputSchema: { workspaceId: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: ro,
  }, ({ workspaceId, limit }) => guard(async () => {
    if (workspaceId != null) return getHistory(prisma, workspaceId, limit);
    const house = await prisma.house.findFirstOrThrow({ orderBy: { id: 'asc' } });
    return getHistory(prisma, { currentOf: house.id }, limit);
  }));

  server.registerTool('list_room_photos', {
    title: 'List room photos', description: 'Photos Michael took with the iPhone app, by room or by scan import: note, tags, guided prompt, and a signed URL you can open (expires in ~10 minutes).',
    inputSchema: { roomId: z.number().int().optional(), scanImportId: z.number().int().optional() }, annotations: ro,
  }, (a) => guard(() => listPhotos(a)));
  server.registerTool('get_scan_import', {
    title: 'Get scan import', description: 'One room scan: status, room, parsed walls/openings/objects (inches), the closest furniture template for each scanned object, and its photos.',
    inputSchema: { scanImportId: z.number().int() }, annotations: ro,
  }, ({ scanImportId }) => guard(async () => { const { preview, ...rest } = await getScanImport(scanImportId); return rest; }));
  server.registerTool('list_templates', {
    title: 'List furniture templates', description: 'The parametric furniture library: template ids/slugs, default sizes, RoomPlan categories they stand in for, and each parameter with its type, default, range or options.',
    annotations: ro,
  }, () => guard(() => listTemplates(prisma)));
  server.registerTool('list_models', {
    title: 'List 3D models', description: 'Captured (Object Capture) and uploaded 3D models, with the placements using them.', annotations: ro,
  }, () => guard(async () => (await prisma.furnitureModel.findMany({ include: { upload: { select: { format: true, bytes: true } }, placements: { select: { id: true, workspaceId: true } } }, orderBy: { id: 'asc' } }))
    .map((m) => ({ id: m.id, label: m.label, source: m.source, format: m.upload.format, bytes: m.upload.bytes, createdAt: m.createdAt, placements: m.placements }))));

  if (rank[scope] >= rank.propose) {
    server.registerTool('create_proposal', {
      title: 'Create proposal',
      description: `Propose a change for Michael to approve or reject. Nothing changes until he approves it in the editor.
Each change is one of:
- {"op":"update","entityType":...,"entityId":N,"field":...,"value":...}
- {"op":"create","entityType":...,"tempRef":"name","fields":{...}} (later changes can use "$name" as an id)
- {"op":"delete","entityType":...,"entityId":N}
Entities and fields (inches; ? = nullable):
${fieldReference()}
Example: add a new piece = create furniture_item (tempRef "i1", status "idea") then create placement {roomId, itemId:"$i1", xIn, yIn, rotationDeg, action:"new"}.
The whole change list is validated before it's stored; pinned measurements are refused.`,
      inputSchema: proposalShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, (input) => guard(() => createProposal(input as any, { actor: 'agent', agentKeyId })));

    const common = {
      workspaceId: proposalShape.workspaceId.describe('Workspace the change is for (it must contain the room / placement). Omit and pass current: true for Current.'),
      current: z.boolean().optional().describe('Propose for Current (the house as it is now) instead of a workspace; Michael approves'),
      title: z.string().min(3).max(200).optional(),
      rationale: proposalShape.rationale, source: proposalShape.source, cost: proposalShape.cost,
      photoIds: proposalShape.photoIds,
    };
    const colorSpec = z.object({ name: z.string().max(60).optional().describe('Paint or finish name, e.g. "Benjamin Moore Chantilly Lace OC-65"'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional();
    const target = (a: any, placementWs?: number | null) => {
      if (a.current && a.workspaceId != null) throw new Error('Pass workspaceId or current: true, not both');
      if (a.current) return { current: true as const, workspaceId: null };
      if (a.workspaceId != null) return { current: false as const, workspaceId: a.workspaceId as number };
      if (placementWs !== undefined) return placementWs === null ? { current: true as const, workspaceId: null } : { current: false as const, workspaceId: placementWs };
      throw new Error('Pass workspaceId, or current: true for Current');
    };
    const propose = (title: string, roomIds: number[], changes: any[], a: any, t: { current: boolean; workspaceId: number | null }) =>
      createProposal({ title: a.title ?? title, rationale: a.rationale, ...(t.current ? { current: true } : { workspaceId: t.workspaceId! }), roomIds, source: a.source, changes, cost: a.cost, photoIds: a.photoIds }, { actor: 'agent', agentKeyId });

    server.registerTool('propose_colors', {
      title: 'Propose room colors',
      description: 'Propose wall, trim, floor and outlet/switch colors for a room: in a workspace (works for Current rooms the workspace links), or with current: true the colors the room has now (e.g. read from photos). Reference the photos you looked at with photoIds. Creates a pending proposal only.',
      inputSchema: { ...common, roomId: z.number().int(), wall: colorSpec, trim: colorSpec, floor: colorSpec, devices: colorSpec.describe('Outlets and switches (plates and devices)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, (a) => guard(async () => {
      const t = target(a);
      const style = await prisma.roomStyle.findFirst({ where: { workspaceId: t.workspaceId, roomId: a.roomId } });
      const fields: Record<string, string> = {};
      for (const [part, prefix] of [['wall', 'wall'], ['trim', 'trim'], ['floor', 'floor'], ['devices', 'device']] as const) {
        const v = (a as any)[part];
        if (v?.name) fields[`${prefix}ColorName`] = v.name;
        if (v?.color) fields[`${prefix}Color`] = v.color.toLowerCase();
      }
      if (!Object.keys(fields).length) throw new Error('Give at least one of wall, trim, floor, devices');
      const changes = style
        ? Object.entries(fields).map(([field, value]) => ({ op: 'update', entityType: 'room_style', entityId: style.id, field, value }))
        : [{ op: 'create', entityType: 'room_style', tempRef: 'colors', fields: { roomId: a.roomId, ...fields } }];
      return propose(t.current ? 'Colors now (Current)' : 'Colors', [a.roomId], changes, a, t);
    }));

    server.registerTool('propose_furniture_template', {
      title: 'Propose a furniture template',
      description: 'Propose drawing a placement with a parametric template (see list_templates) and parameter values. The target defaults to where the placement is (a workspace, or Current for existing furniture). Unknown keys and out-of-range values are refused. Creates a pending proposal only.',
      inputSchema: { ...common, placementId: z.number().int(), template: z.string().max(40).describe('Template slug, e.g. "l_sectional"'), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, (a) => guard(async () => {
      const pl = await prisma.placement.findUnique({ where: { id: a.placementId }, include: { params: true, item: true } });
      if (!pl) throw new Error(`placement ${a.placementId} not found`);
      const t = await prisma.furnitureTemplate.findUnique({ where: { slug: a.template } });
      const def = templateBySlug.get(a.template);
      if (!t || !def) throw new Error(`Unknown template "${a.template}". See list_templates.`);
      const changes: any[] = [];
      if (pl.templateId !== t.id) changes.push({ op: 'update', entityType: 'placement', entityId: pl.id, field: 'templateId', value: t.id });
      const keys = new Set(def.params.map((p) => p.key));
      for (const old of pl.params) if (!keys.has(old.key)) changes.push({ op: 'delete', entityType: 'placement_param', entityId: old.id });
      for (const [key, value] of Object.entries(a.params)) {
        const old = pl.params.find((x) => x.key === key);
        if (old) { if (old.value !== String(value)) changes.push({ op: 'update', entityType: 'placement_param', entityId: old.id, field: 'value', value: String(value) }); }
        else changes.push({ op: 'create', entityType: 'placement_param', fields: { placementId: pl.id, key, value: String(value) } });
      }
      if (!changes.length) throw new Error('Nothing to change: the placement already uses that template and those values');
      const tg = target(a, pl.workspaceId);
      if (tg.workspaceId !== pl.workspaceId) throw new Error(`placement ${pl.id} is in ${pl.workspaceId == null ? 'Current' : `workspace ${pl.workspaceId}`}, not ${tg.current ? 'Current' : `workspace ${tg.workspaceId}`}`);
      return propose(`${pl.item.name}: ${def.name}`, [pl.roomId], changes, a, tg);
    }));

    server.registerTool('propose_attach_model', {
      title: 'Propose attaching a 3D model',
      description: 'Propose showing a placement with an existing 3D model (see list_models) instead of its template. Pass modelId null to propose removing it. Creates a pending proposal only.',
      inputSchema: { ...common, placementId: z.number().int(), modelId: z.number().int().nullable() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, (a) => guard(async () => {
      const pl = await prisma.placement.findUnique({ where: { id: a.placementId }, include: { item: true } });
      if (!pl) throw new Error(`placement ${a.placementId} not found`);
      if (a.modelId != null && !(await prisma.furnitureModel.findUnique({ where: { id: a.modelId } }))) throw new Error(`model ${a.modelId} not found (see list_models)`);
      const ops: any[] = [{ op: 'update', entityType: 'placement', entityId: pl.id, field: 'modelId', value: a.modelId }];
      const tg = target(a, pl.workspaceId);
      if (tg.workspaceId !== pl.workspaceId) throw new Error(`placement ${pl.id} is in ${pl.workspaceId == null ? 'Current' : `workspace ${pl.workspaceId}`}, not ${tg.current ? 'Current' : `workspace ${tg.workspaceId}`}`);
      return propose(a.modelId == null ? `${pl.item.name}: remove 3D model` : `${pl.item.name}: use 3D model #${a.modelId}`, [pl.roomId], ops, a, tg);
    }));
  }
  return server;
}

export async function handleMcp(req: Request): Promise<Response> {
  const h = req.headers.get('authorization');
  const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const key = token ? await prisma.agentKey.findUnique({ where: { keyHash: sha256(token) } }) : null;
  if (!key || key.revokedAt) {
    return new Response(JSON.stringify({ error: 'unauthorized', hint: 'Send Authorization: Bearer <agent key>' }), {
      status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="house-planner"' },
    });
  }
  await prisma.agentKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  const server = buildServer(key.scope as Scope, key.id);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: one server per request.
    setTimeout(() => { transport.close().catch(() => {}); server.close().catch(() => {}); }, 0);
  }
}
