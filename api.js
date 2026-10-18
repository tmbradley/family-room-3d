// Thin client for the house-planner API (same origin, passkey session cookie).
export class ApiError extends Error {
  constructor(status, body) { super(body?.message || body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
}
async function req(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const api = {
  me: () => req('GET', '/api/me'),
  house: () => req('GET', '/api/house'),
  workspaces: () => req('GET', '/api/workspaces'),
  workspace: (id) => req('GET', `/api/workspaces/${id}`),
  createWorkspace: (name, copyFromWorkspaceId) => req('POST', '/api/workspaces', { name, copyFromWorkspaceId }),
  save: (id, baseRevision, changes, note) => req('POST', `/api/workspaces/${id}/changes`, { baseRevision, changes, note }),
  history: (id) => req('GET', `/api/workspaces/${id}/history?limit=100`),
  rollback: (id, toRevision) => req('POST', `/api/workspaces/${id}/rollback`, { toRevision }),
  proposals: (status) => req('GET', `/api/proposals${status ? `?status=${status}` : ''}`),
  preview: (id) => req('GET', `/api/proposals/${id}/preview`),
  approve: (id, note) => req('POST', `/api/proposals/${id}/approve`, { note }),
  reject: (id, note) => req('POST', `/api/proposals/${id}/reject`, { note }),
  measure: (body) => req('POST', '/api/measurements', body),
  unpin: (body) => req('POST', '/api/measurements/unpin', body),
  pairPhone: (scope) => req('POST', '/api/upload-tokens', scope), // { roomId } | { newRoom: true, label } | { placementId }
  scans: (status) => req('GET', `/api/scans${status ? `?status=${status}` : ''}`),
  scan: (id) => req('GET', `/api/scans/${id}`),
  promoteScan: (id) => req('POST', `/api/scans/${id}/promote`),
  rejectScan: (id, notes) => req('POST', `/api/scans/${id}/reject`, { notes }),
  currentHistory: () => req('GET', '/api/current/history?limit=100'),
  rollbackCurrent: (toRevision) => req('POST', '/api/current/rollback', { toRevision }),
  exportHouse: () => req('GET', '/api/export'),
  templates: () => req('GET', '/api/templates'),
  photos: (q) => req('GET', `/api/photos?${new URLSearchParams(q)}`),
  furnishScan: (id, name) => req('POST', `/api/scans/${id}/furnish`, { name }),
  fixMirror: (roomId) => req('POST', `/api/rooms/${roomId}/fix-mirror`),
  setModel: (placementId, modelId) => req('POST', `/api/placements/${placementId}/model`, { modelId }),
  async uploadModel(file, { label, placementId }) {
    const format = /\.glb$/i.test(file.name) ? 'glb' : 'usdz';
    const q = new URLSearchParams({ format, label, ...(placementId ? { placementId: String(placementId) } : {}) });
    const res = await fetch(`/api/models?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  },
};
