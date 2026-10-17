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

type Scope = 'read' | 'propose' | 'admin';
const rank: Record<Scope, number> = { read: 0, propose: 1, admin: 2 };

const INSTRUCTIONS = `House planner for Michael Bradley's house. Lengths are integer inches; room x runs from the
fireplace wall toward the open side, y from the front wall toward the back (window) wall.
The house has no "Current" yet; designs live in workspaces (the Test room workspace is the working data).
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
    title: 'Get room', description: 'One room with walls, openings, fixtures and the placements of a workspace (defaults to the room\'s own workspace), with measurement sources.',
    inputSchema: { roomId: z.number().int(), workspaceId: z.number().int().optional() }, annotations: ro,
  }, ({ roomId, workspaceId }) => guard(() => getRoomView(prisma, roomId, workspaceId)));
  server.registerTool('list_proposals', {
    title: 'List proposals', description: 'Proposals (newest first) with target, rooms, field-level changes (before/after), rationale, source and cost steps. Pass proposalId for one.',
    inputSchema: {
      status: z.enum(['pending', 'approved', 'rejected']).optional(), workspaceId: z.number().int().optional(),
      proposalId: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional(),
    }, annotations: ro,
  }, (a) => guard(async () => (a.proposalId != null ? [await getProposal(a.proposalId)] : listProposals(a))));
  server.registerTool('get_history', {
    title: 'Get history', description: 'Append-only revision history of a workspace (newest first) with field-level changes.',
    inputSchema: { workspaceId: z.number().int(), limit: z.number().int().min(1).max(200).optional() }, annotations: ro,
  }, ({ workspaceId, limit }) => guard(() => getHistory(prisma, workspaceId, limit)));

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
