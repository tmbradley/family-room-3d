// House planner editor: workspaces as tabs, split view with synced cameras, proposals, history,
// measurements. All data comes from and goes to the API; every edit is a revision.
import { CATALOG } from './catalog.js';
import { RoomView, escapeHtml as esc, footprintFt, setTemplates } from './scene.js';
import { api, ApiError } from './api.js';
import { UndoBook, applyEntry, shortcutFor } from './undo.js';

const $ = (id) => document.getElementById(id);
const LS = { tabs: 'hp.tabs.v1', drafts: 'hp.drafts.v1', prefs: 'hp.prefs.v1' };
const params = new URLSearchParams(location.search);
const prefs = Object.assign({ sync: true, mode: '3d', walls: 'cut', snap: true, labels: true }, JSON.parse(localStorage.getItem(LS.prefs) || '{}'));
const savePrefs = () => localStorage.setItem(LS.prefs, JSON.stringify(prefs));

const state = {
  me: null, editable: false, house: null, workspaces: [], cache: new Map(), previews: new Map(),
  openTabs: JSON.parse(localStorage.getItem(LS.tabs) || 'null'), panes: [], focused: 0,
  drawer: null, proposals: [], selection: null, scans: [], scanPreviews: new Map(), scanReview: null, templates: [],
  undo: new UndoBook(100), undoBusy: false, // per-tab undo/redo (in memory, this browser tab only)
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}
const fmtIn = (n) => { if (n == null) return '—'; const f = Math.floor(Math.abs(n) / 12), i = Math.abs(n) % 12; return `${n < 0 ? '−' : ''}${f ? `${f}' ` : ''}${i}"`; };
const fmtVal = (field, v) => (v == null ? '∅' : /In$/.test(field || '') && /^-?\d+$/.test(String(v)) ? `${v}" (${fmtIn(Number(v))})` : String(v));
const usd = (n) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const when = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const wsName = (id) => state.workspaces.find((w) => w.id === id)?.name ?? `Workspace ${id}`;
const keyWs = (key) => (key?.startsWith('ws:') ? Number(key.slice(3)) : null);
const keyPv = (key) => (key?.startsWith('pv:') ? Number(key.slice(3)) : null);
const keySc = (key) => (key?.startsWith('sc:') ? Number(key.slice(3)) : null);
const currentData = () => ({ id: null, name: 'Current', revision: state.house.current.revision, units: 'in', rooms: state.house.current.rooms });
const saveTabs = () => localStorage.setItem(LS.tabs, JSON.stringify(state.openTabs));
function errMsg(e) { return e instanceof ApiError ? e.body?.message || e.body?.error || e.message : e?.message || String(e); }

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadWs(id, force = false) {
  if (!force && state.cache.has(id)) return state.cache.get(id);
  const v = await api.workspace(id);
  state.cache.set(id, v);
  return v;
}
async function refreshList() {
  state.workspaces = await api.workspaces();
  const ids = new Set(state.workspaces.map((w) => w.id));
  state.openTabs = (state.openTabs ?? state.workspaces.map((w) => w.id)).filter((id) => ids.has(id));
  if (!state.openTabs.length && state.workspaces.length) state.openTabs = [state.workspaces[0].id];
  saveTabs();
}
async function refreshProposals() {
  const all = await api.proposals($('propFilter').value || undefined);
  state.proposals = all;
  const pending = $('propFilter').value === 'pending' ? all.length : (await api.proposals('pending')).length;
  $('pendingCount').hidden = !pending; $('pendingCount').textContent = pending;
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------
function makePane(index) {
  const el = document.createElement('div'); el.className = 'pane';
  el.innerHTML = `<div class="pane-head"><span class="name"></span><span class="rev"></span><span class="tools"></span></div><div class="pane-view"></div>`;
  $('panes').appendChild(el);
  const pane = { el, key: null };
  pane.view = new RoomView(el.querySelector('.pane-view'), {
    onSelect: (v, p) => { if (paneOf(v) === state.panes[state.focused]) { state.selection = p; renderSelection(); } },
    onCommit: (v, p, before) => commitMove(paneOf(v), p, before),
    onCamera: (v) => syncFrom(paneOf(v)),
    onInteract: (v) => focusPane(state.panes.indexOf(paneOf(v))),
  });
  applyViewPrefs(pane.view);
  el.addEventListener('pointerdown', () => focusPane(state.panes.indexOf(pane)), { capture: true });
  return pane;
}
const paneOf = (view) => state.panes.find((p) => p.view === view);
function applyViewPrefs(v) { v.walls = prefs.walls; v.snap = prefs.snap; v.setMode(prefs.mode); }

function focusPane(i) {
  if (i < 0 || i === state.focused) return;
  state.focused = i;
  state.panes.forEach((p, j) => p.el.classList.toggle('focused', j === i && state.panes.length > 1));
  state.selection = null; renderSelection(); renderTabs(); renderRoomPhotos(); renderUndo();
  if (state.drawer === 'history') renderHistory();
}

async function show(i, key) {
  const pane = state.panes[i]; pane.key = key;
  const wsId = keyWs(key), pvId = keyPv(key), scId = keySc(key);
  let data, editable = false, highlight = [];
  try {
    if (key === 'cur') { if (!state.house?.hasCurrent) return; data = currentData(); }
    else if (scId != null) { data = state.scanPreviews.get(scId)?.preview; if (!data) return; }
    else if (wsId != null) { data = await loadWs(wsId); editable = state.editable; }
    else if (pvId != null) {
      if (!state.previews.has(pvId)) state.previews.set(pvId, await api.preview(pvId));
      data = state.previews.get(pvId); highlight = data.preview.changedEntities;
    }
  } catch (e) { toast(`Couldn't load: ${errMsg(e)}`, true); return; }
  if (pane.key !== key) return;
  pane.data = data;
  pane.view.setData(data, { editable, highlight });
  const head = pane.el.querySelector('.pane-head');
  head.querySelector('.name').textContent = pvId != null ? `Preview: proposal #${pvId} · ${data.preview.title}` : data.name;
  head.querySelector('.rev').textContent = pvId != null || scId != null ? '' : `rev ${data.revision}`;
  const tools = head.querySelector('.tools');
  tools.innerHTML = pvId != null || scId != null
    ? `<span class="chip">preview, not saved</span>`
    : key === 'cur' ? `<span class="chip ro" title="Current is the house as it is now. Structure changes through scans and measurements; furniture and colors through proposals you approve.">locked: scans, measurements, approved proposals</span>`
    : editable ? '' : `<span class="chip ro">read-only</span>`;
  if (editable && wsId != null && data.rooms?.some((r) => r.draftWorkspaceId == null)) {
    const b = document.createElement('button'); b.textContent = "Make Current's furniture…";
    b.title = "Propose this design's existing pieces and colors as what is in the house now (you approve it in Proposals)";
    b.onclick = (e) => { e.stopPropagation(); proposeAsCurrent(wsId); };
    tools.appendChild(b);
  }
  if (state.panes.length > 1 && i === 1) {
    const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Close split'; x.onclick = (e) => { e.stopPropagation(); setSplit(false); };
    tools.appendChild(x);
  }
  renderTabs();
  if (i === state.focused) { const sel = pane.view.selected; state.selection = sel != null ? pane.view.placement(sel) : null; renderSelection(); renderRoomPhotos(); renderUndo(); }
}

async function rerenderWs(wsId) {
  await loadWs(wsId, true);
  for (let i = 0; i < state.panes.length; i++) if (keyWs(state.panes[i].key) === wsId) await show(i, state.panes[i].key);
  await refreshList(); renderTabs();
  if (state.drawer === 'history') renderHistory();
}

function setSplit(on, key) {
  if (on && state.panes.length === 1) {
    state.panes.push(makePane(1));
    const other = key ?? tabKeys().find((k) => k !== state.panes[0].key) ?? state.panes[0].key;
    show(1, other).then(() => { state.panes[0].view.resize(); state.panes[0].view.fit(); state.panes[0].view.setMode(prefs.mode); syncFrom(state.panes[0], true); });
  } else if (!on && state.panes.length === 2) {
    const p = state.panes.pop(); p.view.dispose(); p.el.remove();
    state.focused = 0;
    requestAnimationFrame(() => { const v = state.panes[0].view; v.resize(); v.fit(); v.setMode(prefs.mode); });
  }
  state.panes.forEach((p, j) => p.el.classList.toggle('focused', j === state.focused && state.panes.length > 1));
  $('btnSplit').classList.toggle('active', state.panes.length > 1);
  renderTabs();
}

function syncFrom(src, force = false) {
  if (!src || state.panes.length < 2 || !prefs.sync) return;
  const cam = src.view.getCamera();
  for (const p of state.panes) if (p !== src) p.view.setCamera(cam);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabKeys = () => [...(state.house?.hasCurrent ? ['cur'] : []), ...state.openTabs.map((id) => `ws:${id}`), ...[...state.previews.keys()].map((id) => `pv:${id}`), ...[...state.scanPreviews.keys()].map((id) => `sc:${id}`)];
function renderTabs() {
  const tabs = $('tabs'); tabs.innerHTML = '';
  const cur = document.createElement('div');
  if (!state.house?.hasCurrent) {
    cur.className = 'tab current-empty'; cur.textContent = 'Current: none yet'; cur.title = 'No Current yet. Create one from a scan or confirmed measurements.';
    tabs.appendChild(cur);
  }
  const shown = new Set(state.panes.map((p) => p.key));
  for (const key of tabKeys()) {
    const t = document.createElement('div');
    const wsId = keyWs(key), pvId = keyPv(key), scId = keySc(key);
    t.className = 'tab' + (pvId != null || scId != null ? ' preview' : '') + (state.panes[state.focused]?.key === key ? ' active' : shown.has(key) ? ' shown' : '');
    t.setAttribute('role', 'tab');
    const label = key === 'cur' ? 'Current' : wsId != null ? wsName(wsId) : scId != null ? `Scan #${scId}` : `Preview #${pvId}`;
    t.innerHTML = `<span class="t">${esc(label)}</span>${key === 'cur' ? '' : '<span class="x" title="Close tab">✕</span>'}`;
    t.title = wsId != null && state.editable ? 'Double-click to rename' : label;
    t.onclick = (e) => { if (e.target.classList.contains('x')) return; show(state.focused, key); };
    t.ondblclick = () => wsId != null && renameWs(wsId);
    t.querySelector('.x')?.addEventListener('click', (e) => { e.stopPropagation(); closeTab(key); });
    tabs.appendChild(t);
  }
}
function closeTab(key) {
  const wsId = keyWs(key), pvId = keyPv(key), scId = keySc(key);
  if (key === 'cur') return;
  if (scId != null) state.scanPreviews.delete(scId);
  else if (wsId != null) {
    if (state.openTabs.length <= 1 && !state.previews.size) return toast('Keep at least one tab open');
    state.openTabs = state.openTabs.filter((id) => id !== wsId); saveTabs();
  } else if (pvId != null) state.previews.delete(pvId);
  state.panes.forEach((p, i) => {
    if (p.key === key) {
      const next = tabKeys()[0];
      if (i === 1 || !next) setSplit(false); else show(i, next);
    }
  });
  renderTabs();
}
function openTab(wsId, pane = state.focused) {
  if (!state.openTabs.includes(wsId)) { state.openTabs.push(wsId); saveTabs(); }
  return show(pane, `ws:${wsId}`);
}
async function renameWs(id) {
  if (!state.editable) return;
  const ws = await loadWs(id);
  const name = prompt('Rename workspace', ws.name)?.trim();
  if (!name || name === ws.name) return;
  await saveOps(id, [{ op: 'update', entityType: 'workspace', entityId: id, field: 'name', value: name }], `Renamed to "${name}"`);
}
function renderNewMenu() {
  const m = $('newMenu'); m.innerHTML = '';
  const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  if (state.house?.hasCurrent) add('New design from Current (its furniture and colors)', () => createWs(undefined, 'New design', 'current'));
  else { const cur = document.createElement('div'); cur.className = 'disabled'; cur.textContent = 'New design from Current (no Current yet)'; m.appendChild(cur); }
  add('Blank workspace (rooms only, no furniture)', () => createWs(undefined, 'New design', 'none'));
  const sep = document.createElement('div'); sep.className = 'sep'; m.appendChild(sep);
  for (const w of state.workspaces) add(`Copy of “${w.name}”`, () => createWs(w.id, `${w.name} (copy)`));
}
async function createWs(copyFrom, suggested, furnishings) {
  const name = prompt('Name for the new workspace', suggested || 'New design')?.trim();
  if (!name) return;
  try {
    const ws = await api.createWorkspace(name, copyFrom, furnishings);
    state.cache.set(ws.id, ws); await refreshList();
    await openTab(ws.id);
    toast(`Created “${ws.name}”`);
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Editing (every edit = a revision; Michael's own edits count as approved)
// ---------------------------------------------------------------------------
async function saveOps(wsId, changes, note, local) {
  const ws = await loadWs(wsId);
  $('saveStatus').textContent = 'Saving…';
  try {
    const r = await api.save(wsId, ws.revision, changes, note);
    $('saveStatus').textContent = r.unchanged ? 'No change.' : `Saved as revision ${r.revision} · ${new Date().toLocaleTimeString()}`;
    clearDraft(wsId);
    if (!r.unchanged) recordUndo(`ws:${wsId}`, { kind: 'rev', wsId, revision: r.revision, label: note });
    await rerenderWs(wsId);
    return r;
  } catch (e) {
    if (e instanceof ApiError) {
      $('saveStatus').textContent = 'Not saved.';
      toast(e.status === 409 && e.body?.error === 'conflict' ? 'This workspace changed on another device. Reloaded the latest.' : `Not saved: ${errMsg(e)}`, true);
      await rerenderWs(wsId);
    } else {
      const draft = keepDraft(wsId, ws.revision, changes, note, local);
      recordUndo(`ws:${wsId}`, { kind: 'draft', wsId, draft, label: note });
      $('saveStatus').textContent = 'Offline: kept as a draft on this device; it will be saved when you reconnect.';
    }
  }
}
function drafts() { return JSON.parse(localStorage.getItem(LS.drafts) || '[]'); }
function keepDraft(wsId, baseRevision, changes, note, local) {
  // local: [{ id, field, before, after }] for edits already drawn on screen (moves), so undo can draw them back offline.
  const d = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, wsId, baseRevision, changes, note, local };
  queueDraft(d); return d;
}
function queueDraft(d) { localStorage.setItem(LS.drafts, JSON.stringify([...drafts(), d])); }
function dropDraft(d) { const list = drafts(); const rest = list.filter((x) => x.id !== d.id); localStorage.setItem(LS.drafts, JSON.stringify(rest)); return rest.length < list.length; }
function clearDraft(wsId) { localStorage.setItem(LS.drafts, JSON.stringify(drafts().filter((d) => d.wsId !== wsId))); }
async function flushDrafts() {
  const list = drafts(); if (!list.length || !state.editable) return;
  localStorage.setItem(LS.drafts, '[]');
  for (const d of list) {
    try {
      const r = await api.save(d.wsId, d.baseRevision, d.changes, d.note); toast('Saved your offline edits');
      // Its undo entry now points at the saved revision.
      if (d.id) state.undo.replaceAll((e) => e.draft?.id === d.id, (e) => (e.kind === 'draft' && !r.unchanged ? { kind: 'rev', wsId: d.wsId, revision: r.revision, label: e.label } : e));
    } catch (e) { if (!(e instanceof ApiError)) { queueDraft(d); return; } toast(`An offline edit couldn't be saved: ${errMsg(e)}`, true); }
  }
  renderUndo();
  for (const id of new Set(list.map((d) => d.wsId))) if (state.cache.has(id)) await rerenderWs(id);
}
window.addEventListener('online', flushDrafts);

function commitMove(pane, p, before) {
  const wsId = keyWs(pane?.key); if (wsId == null) return;
  const changes = ['xIn', 'yIn', 'rotationDeg'].filter((f) => p[f] !== before[f]).map((f) => ({ op: 'update', entityType: 'placement', entityId: p.id, field: f, value: p[f] }));
  if (changes.length) saveOps(wsId, changes, `${changes.some((c) => c.field === 'rotationDeg') && changes.length === 1 ? 'Rotated' : 'Moved'} ${p.item.name}`, changes.map((c) => ({ id: p.id, field: c.field, before: before[c.field], after: p[c.field] })));
}
function focusedWs() { return keyWs(state.panes[state.focused]?.key); }
function addPiece(spec) {
  const wsId = focusedWs(); const data = state.panes[state.focused].data;
  if (wsId == null || !data.rooms.length) return toast('Open a workspace with a room first', true);
  const room = data.rooms[0];
  const xs = room.walls.flatMap((w) => [w.startXIn, w.endXIn]), ys = room.walls.flatMap((w) => [w.startYIn, w.endYIn]);
  const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  saveOps(wsId, [
    { op: 'create', entityType: 'furniture_item', tempRef: 'i', fields: { kind: spec.kind, name: spec.name, wIn: Math.round(spec.w), dIn: Math.round(spec.d), hIn: Math.max(1, Math.round(spec.h)), color: spec.color, accentColor: spec.accent ?? null, status: 'idea', url: spec.url || null, priceCents: spec.price ? Math.round(spec.price * 100) : null } },
    { op: 'create', entityType: 'placement', tempRef: 'p', fields: { roomId: room.id, itemId: '$i', xIn: cx, yIn: cy, rotationDeg: 0, action: 'new' } },
  ], `Added ${spec.name}`);
}

// ---------------------------------------------------------------------------
// Selection + measurements panels
// ---------------------------------------------------------------------------
function renderSelection() {
  const p = state.selection, pane = state.panes[state.focused];
  const editable = state.editable && keyWs(pane?.key) != null;
  $('btnRotate').disabled = $('btnDelete').disabled = !p || !editable;
  $('actionRow').hidden = !p || !editable;
  renderTemplatePanel(p, editable);
  if (!p) { $('selInfo').innerHTML = 'Tap a piece to select it. Drag to move.'; renderMeasurements(); return; }
  const f = footprintFt(p);
  $('selInfo').innerHTML = `<b>${esc(p.item.name)}</b><br>${fmtIn(p.item.wIn)} W × ${fmtIn(p.item.dIn)} D × ${fmtIn(p.item.hIn)} H<br>
    At x ${fmtIn(p.xIn)}, y ${fmtIn(p.yIn)} · rotated ${p.rotationDeg}°<br>
    <span class="small">Footprint ${fmtIn(Math.round(f.w * 12))} × ${fmtIn(Math.round(f.d * 12))} · ${esc(p.action)}${p.item.status ? ' · ' + esc(p.item.status) : ''}</span>`;
  $('actionSel').value = p.action;
  renderMeasurements();
}
function measRow(entityType, entityId, field, label, value, m) {
  const src = m?.[field];
  const pinned = !!src?.pinned;
  const key = state.panes[state.focused]?.key;
  const can = state.editable && (keyWs(key) != null || key === 'cur');
  return `<div class="meas" data-et="${entityType}" data-id="${entityId}" data-field="${field}">
    <span>${esc(label)}<span class="src ${src?.source ?? 'manual_estimate'}">${pinned ? 'pinned' : esc((src?.source ?? 'estimate').replace('manual_estimate', 'estimate'))}</span></span>
    <input type="number" step="1" min="0" value="${value ?? ''}" ${can && !pinned ? '' : 'disabled'} aria-label="${esc(label)} in inches">
    ${can ? (pinned ? `<button data-act="unpin" title="Release the pin">Unpin</button><span></span>` : `<button data-act="measured" title="Save as a tape measurement">Measured</button><button data-act="pin" title="Pin: scans and estimates can never overwrite it">Pin</button>`) : '<span></span><span></span>'}
  </div>`;
}
function renderMeasurements() {
  const el = $('measPanel'), pane = state.panes[state.focused], data = pane?.data;
  if (!data) { el.innerHTML = ''; return; }
  const p = state.selection;
  let html = '';
  if (p) {
    const it = p.item;
    html += `<div class="small"><b>${esc(it.name)}</b> (inches)</div>`;
    html += measRow('furniture_item', it.id, 'wIn', 'Width', it.wIn, it.measurements);
    html += measRow('furniture_item', it.id, 'dIn', 'Depth', it.dIn, it.measurements);
    html += measRow('furniture_item', it.id, 'hIn', 'Height', it.hIn, it.measurements);
  } else {
    for (const r of data.rooms) {
      html += `<div class="small"><b>${esc(r.label)}</b> (inches)</div>`;
      html += measRow('room', r.id, 'ceilingIn', 'Ceiling', r.ceilingIn, r.measurements);
      for (const w of r.walls.filter((w) => !w.isOpen)) {
        html += measRow('wall', w.id, 'heightIn', `${w.label ?? 'Wall'} height`, w.heightIn, w.measurements);
        for (const o of w.openings) html += measRow('opening', o.id, 'widthIn', `${o.label ?? o.type} width`, o.widthIn, o.measurements);
      }
    }
    if (!data.rooms.length) html = '<span class="muted small">No rooms in this workspace.</span>';
  }
  el.innerHTML = html;
  el.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = () => measure(b)));
}
async function measure(btn) {
  const row = btn.closest('.meas'), wsId = focusedWs(), key = state.panes[state.focused]?.key;
  const body = { workspaceId: wsId, entityType: row.dataset.et, entityId: Number(row.dataset.id), field: row.dataset.field };
  const inp = row.querySelector('input'), beforeIn = inp.defaultValue === '' ? undefined : Number(inp.defaultValue);
  const what = `${row.querySelector('span')?.firstChild?.textContent ?? row.dataset.field}`;
  try {
    if (btn.dataset.act === 'unpin') {
      await api.unpin(body); toast('Unpinned. The newest measurement is used again.');
      if (beforeIn != null) recordUndo(key, { kind: 'repin', key, body, valueIn: beforeIn, label: `Unpin ${what}` });
    } else {
      const valueIn = Math.round(Number(inp.value));
      if (!Number.isFinite(valueIn) || valueIn <= 0) return toast('Enter a value in inches', true);
      const r = await api.measure({ ...body, valueIn, action: btn.dataset.act === 'pin' ? 'pin' : 'measured' });
      recordUndo(key, { kind: 'meas', key, measurementId: r.measurementId, withdraw: true, restoreIn: beforeIn, workspaceId: wsId, label: `${btn.dataset.act === 'pin' ? 'Pin' : 'Measure'} ${what}: ${fmtIn(valueIn)}` });
      toast(r.applied ? (btn.dataset.act === 'pin' ? `Pinned at ${fmtIn(valueIn)}. Scans and estimates won't change it.` : `Saved ${fmtIn(valueIn)} as measured`) : `Recorded, but the pinned value (${fmtIn(r.effective.valueIn)}) still wins`);
    }
    const sel = state.selection?.id;
    if (state.panes[state.focused]?.key === 'cur') { await refreshHouse(); return; }
    await rerenderWs(wsId);
    if (sel) state.panes[state.focused].view.select(sel);
  } catch (e) { toast(errMsg(e), true); }
}


// ---------------------------------------------------------------------------
// Templates and 3D models for the selected piece
// ---------------------------------------------------------------------------
function renderTemplatePanel(p, editable) {
  const el = $('tplPanel');
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const t = p.template ? state.templates.find((x) => x.slug === p.template.slug) : null;
  const vals = { ...(t ? Object.fromEntries(t.params.map((q) => [q.key, q.default])) : {}), ...(p.template?.params ?? {}) };
  const dis = editable ? '' : 'disabled';
  const input = (q) => {
    const v = vals[q.key];
    if (q.type === 'choice') return `<select data-k="${esc(q.key)}" ${dis}>${q.options.map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    if (q.type === 'color') return `<input type="color" data-k="${esc(q.key)}" value="${esc(v)}" ${dis}>`;
    if (q.type === 'boolean') return `<input type="checkbox" data-k="${esc(q.key)}" ${v === 'true' ? 'checked' : ''} ${dis}>`;
    return `<input type="number" data-k="${esc(q.key)}" value="${esc(v)}" min="${q.min}" max="${q.max}" step="1" ${dis}>`;
  };
  const m = p.model;
  el.innerHTML = `<label class="prm"><span>Template</span><select id="tplSel" ${dis}><option value="">(basic shape)</option>${state.templates.map((x) => `<option value="${esc(x.slug)}" ${x.slug === p.template?.slug ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    ${t ? t.params.map((q) => `<label class="prm"><span>${esc(q.label)}</span>${input(q)}</label>`).join('') : ''}
    <div class="model">${m ? `<b>3D model:</b> ${esc(m.label)} <span class="muted">(${esc(m.format)}, ${m.source === 'object_capture' ? 'captured on iPhone' : 'uploaded'}, ${Math.round((m.bytes ?? 0) / 1024)} KB)</span><br><span class="muted">The model is drawn instead of the template.</span>` : '<span class="muted">No 3D model. The template is drawn.</span>'}
      ${editable ? `<div class="row"><button id="btnCapture" title="Pair the iPhone app to capture this piece with Object Capture">Capture this piece</button><button id="btnModelFile">Upload model…</button>${m ? '<button id="btnModelOff" class="danger">Remove model</button>' : ''}</div><input type="file" id="modelFile" accept=".usdz,.glb,model/vnd.usdz+zip,model/gltf-binary" hidden>` : ''}
    </div>`;
  if (!editable) return;
  const wsId = focusedWs();
  $('tplSel').onchange = (e) => setTemplate(wsId, p, e.target.value);
  el.querySelectorAll('[data-k]').forEach((inp) => (inp.onchange = () => setParam(wsId, p, inp.dataset.k, inp.type === 'checkbox' ? String(inp.checked) : inp.value)));
  $('btnCapture').onclick = () => showCaptureDialog(p);
  $('btnModelFile').onclick = () => $('modelFile').click();
  $('modelFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!/\.(usdz|glb)$/i.test(f.name)) return toast('Choose a .usdz or .glb file', true);
    try { $('saveStatus').textContent = 'Uploading model…'; await api.uploadModel(f, { label: f.name.replace(/\.[^.]+$/, ''), placementId: p.id }); toast('Model attached'); await rerenderWs(wsId); }
    catch (err) { toast(`Upload failed: ${errMsg(err)}`, true); }
  };
  if (m) $('btnModelOff').onclick = async () => { try { await api.setModel(p.id, null); toast('Model removed; the template is drawn again'); await rerenderWs(wsId); } catch (err) { toast(errMsg(err), true); } };
}
function setTemplate(wsId, p, slug) {
  const t = state.templates.find((x) => x.slug === slug);
  const changes = [{ op: 'update', entityType: 'placement', entityId: p.id, field: 'templateId', value: t ? t.id : null }];
  // Parameters belong to a template: drop the ones the new template doesn't have.
  for (const [key, id] of Object.entries(p.template?.paramIds ?? {})) if (!t || !t.params.some((q) => q.key === key)) changes.push({ op: 'delete', entityType: 'placement_param', entityId: id });
  saveOps(wsId, changes, t ? `${p.item.name}: ${t.name} template` : `${p.item.name}: basic shape`);
}
function setParam(wsId, p, key, value) {
  const id = p.template?.paramIds?.[key];
  const label = state.templates.find((x) => x.slug === p.template?.slug)?.params.find((q) => q.key === key)?.label ?? key;
  saveOps(wsId, [id ? { op: 'update', entityType: 'placement_param', entityId: id, field: 'value', value } : { op: 'create', entityType: 'placement_param', fields: { placementId: p.id, key, value } }], `${p.item.name}: ${label}`);
}
async function showCaptureDialog(p) {
  let r;
  try { r = await api.pairPhone({ placementId: p.id }); } catch (e) { return toast(errMsg(e), true); }
  const url = `${location.origin}/scan?token=${encodeURIComponent(r.token)}`;
  const svg = await qrSvg(url);
  modal(`<h2>Capture “${esc(p.item.name)}”</h2>
    <p class="small">On a LiDAR iPhone (iOS 17+): scan the code with the Camera to open House Planner, or type it in the app, then walk around the piece. The model is processed on the phone and attached to this piece (one revision you can roll back).</p>
    ${svg ? `<div style="text-align:center">${svg}</div>` : ''}
    <div class="code-box">${esc(r.token)}</div>
    <p class="small">Expires ${when(r.expiresAt)}</p>
    <div class="row"><button data-close>Done</button></div>`);
}

// ---------------------------------------------------------------------------
// Room photos (signed URLs, valid ~10 minutes) and colors
// ---------------------------------------------------------------------------
let photoReq = 0;
async function renderRoomPhotos() {
  const sec = $('photoSection'), data = state.panes[state.focused]?.data, n = ++photoReq;
  const rooms = data?.rooms ?? [];
  if (!rooms.length || keySc(state.panes[state.focused]?.key) != null) { sec.hidden = true; return; }
  const sw = (c) => (c?.color ? `<span class="swatch" style="background:${esc(c.color)}"></span>${esc(c.name ?? c.color)}` : c?.name ? esc(c.name) : '—');
  $('roomStyle').innerHTML = rooms.map((r) => `<div><b>${esc(r.label)}</b>: walls ${sw(r.wallColor)} · trim ${sw(r.trimColor)} · floor ${sw({ color: r.floor?.color, name: r.floor?.colorName })} · outlets/switches ${sw(r.deviceColor)}</div>
    ${r.mirrored ? `<div class="mirror-banner">This room came from an older scan and is drawn as a <b>mirror image</b>. ${state.editable ? `<button data-mirror="${r.id}">Fix mirror image</button>` : 'Michael can fix it.'}</div>` : ''}`).join('');
  const wsId = keyWs(state.panes[state.focused]?.key);
  if (state.editable && wsId != null) {
    const hex = (c) => (/^#[0-9a-f]{6}/i.test(c ?? '') ? c.slice(0, 7) : '#ffffff');
    $('roomStyle').insertAdjacentHTML('beforeend', rooms.map((r) => `<div class="colors" data-room="${r.id}"><span class="muted">Colors in this design:</span>
      ${[['wall', 'Walls', r.wallColor?.color], ['trim', 'Trim', r.trimColor?.color], ['floor', 'Floor', r.floor?.color], ['device', 'Outlets', r.deviceColor?.color]]
        .map(([k, l, c]) => `<label title="${l} color (undo with ⌘Z / Ctrl+Z)">${l} <input type="color" data-color="${k}" value="${esc(hex(c))}"></label>`).join('')}</div>`).join(''));
    $('roomStyle').querySelectorAll('.colors input[data-color]').forEach((inp) => (inp.onchange = () => {
      const room = rooms.find((r) => r.id === Number(inp.closest('.colors').dataset.room));
      setColor(wsId, room, inp.dataset.color, inp.value);
    }));
  }
  $('roomStyle').querySelectorAll('button[data-mirror]').forEach((b) => (b.onclick = () => fixMirror(Number(b.dataset.mirror))));
  sec.hidden = false;
  let photos = [];
  try { photos = (await Promise.all(rooms.map((r) => api.photos({ roomId: r.id })))).flat(); } catch { /* reader without photos */ }
  if (n !== photoReq) return;
  $('photoStrip').innerHTML = photos.length ? photos.map(photoThumb).join('') : '<span class="muted small">No photos for this room yet.</span>';
}
function setColor(wsId, room, k, value) {
  const label = { wall: 'walls', trim: 'trim', floor: 'floor', device: 'outlets/switches' }[k];
  const st = room.style;
  const changes = st
    ? [{ op: 'update', entityType: 'room_style', entityId: st.id, field: `${k}Color`, value }, ...(st[`${k}ColorName`] ? [{ op: 'update', entityType: 'room_style', entityId: st.id, field: `${k}ColorName`, value: null }] : [])]
    : [{ op: 'create', entityType: 'room_style', fields: { roomId: room.id, [`${k}Color`]: value } }];
  saveOps(wsId, changes, `${room.label}: ${label} color ${value}`);
}
const photoThumb = (ph) => `<a href="${esc(ph.url)}" target="_blank" rel="noopener" title="${esc([ph.prompt, ph.note, ph.tags.join(', ')].filter(Boolean).join(' · '))}"><img src="${esc(ph.url)}" alt="${esc(ph.prompt ?? 'Room photo')}" loading="lazy"></a>`;
async function fixMirror(roomId) {
  if (!confirm('Flip this room back to the right way round?\n\nOlder scans were parsed as a mirror image. This flips its walls (one Current revision you can roll back).')) return;
  try { const r = await api.fixMirror(roomId); toast(`Fixed. Current revision ${r.revision}.`); await refreshHouse(); renderRoomPhotos(); }
  catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Drawer: proposals and history
// ---------------------------------------------------------------------------
function openDrawer(kind, scanId) {
  if (kind === 'scan' && scanId != null) state.scanReview = scanId;
  state.drawer = state.drawer === kind ? null : kind;
  $('drawer').hidden = !state.drawer;
  $('btnProposals').classList.toggle('active', state.drawer === 'proposals');
  $('btnHistory').classList.toggle('active', state.drawer === 'history');
  $('propFilter').hidden = state.drawer !== 'proposals';
  if (state.drawer === 'proposals') renderProposals();
  if (state.drawer === 'history') renderHistory();
  if (state.drawer === 'scan') renderScanReview(state.scanReview);
  window.dispatchEvent(new Event('resize'));
}
function diffRow(c) {
  if (c.op === 'measure') return `<tr><td>${esc(c.entityType)} ${esc(c.label ?? '')} <span class="meta">#${c.entityId}</span><br><span class="meta">${esc(c.field)}${c.note ? ` · ${esc(c.note)}` : ''}</span></td><td><span class="before">${esc(fmtVal(c.field, c.before))}</span> → <span class="after">${esc(fmtVal(c.field, c.after))}</span></td></tr>`;
  const what = `${esc(c.entityType.replace('_', ' '))} ${esc(c.label ?? '')}${c.entityId ? ` <span class="meta">#${c.entityId}</span>` : ''}`;
  if (c.op === 'update') return `<tr><td>${what}<br><span class="meta">${esc(c.field)}</span></td><td><span class="before">${esc(fmtVal(c.field, c.before))}</span> → <span class="after">${esc(fmtVal(c.field, c.after))}</span></td></tr>`;
  if (c.op === 'delete') return `<tr><td>${what}</td><td><span class="before">delete</span></td></tr>`;
  const f = Object.entries(c.fields ?? {}).map(([k, v]) => `${esc(k)}: ${esc(fmtVal(k, v))}`).join(', ');
  return `<tr><td>new ${esc(c.entityType.replace('_', ' '))} ${esc(c.label ?? '')}</td><td><span class="after">${f}</span></td></tr>`;
}
function proposalCard(p) {
  const target = p.target.kind === 'current' ? (p.target.what === 'furnishings' ? 'Current (furniture and colors as they are now)' : 'Current (measurements)') : p.target.kind === 'new_workspace'
    ? `New workspace “${esc(p.target.name)}” (copy of ${esc(p.target.copyFrom?.name ?? '?')})${p.target.createdWorkspace ? ` → created #${p.target.createdWorkspace.id}` : ''}`
    : esc(p.target.workspace?.name ?? 'deleted workspace');
  const src = p.source.url ? `<a href="${esc(p.source.url)}" target="_blank" rel="noopener">${esc(p.source.kind.replace('_', ' '))}</a>` : esc(p.source.kind.replace('_', ' '));
  const steps = p.cost.steps.map((s) => `<tr><td>${esc(s.step)}</td><td>${esc(s.changes)}</td><td class="num">${usd(s.lowUsd)}–${usd(s.highUsd)}</td></tr>`).join('');
  const can = state.editable && p.status === 'pending';
  return `<div class="card" data-id="${p.id}">
    <div class="meta"><span class="status ${p.status}">${p.status}</span> #${p.id} · ${when(p.createdAt)} · by ${esc(p.agent ?? p.createdBy)} · source: ${src}</div>
    <h3>${esc(p.title)}</h3>
    <div class="meta">Target: ${target} · Room: ${p.rooms.map((r) => esc(r.label)).join(', ')}</div>
    <p>${esc(p.rationale)}</p>
    <b>${p.kind === 'measurements' ? 'Measurements to record' : 'Changes'}</b><table class="diff">${p.changes.map(diffRow).join('')}</table>
    ${p.photos?.length ? `<div class="photo-strip">${p.photos.map(photoThumb).join('')}</div>` : ''}
    <b>Cost to change: ${usd(p.cost.lowUsd)}–${usd(p.cost.highUsd)}</b>
    <table class="cost"><tr><th>Step</th><th>What changes</th><th class="num">Low–high</th></tr>${steps}</table>
    ${p.decidedAt ? `<div class="meta">Decided ${when(p.decidedAt)}${p.decisionNote ? `: ${esc(p.decisionNote)}` : ''}${p.appliedRevision ? ` · applied as revision ${p.appliedRevision.number}` : ''}</div>` : ''}
    <div class="actions">
      ${p.status === 'pending' && p.kind !== 'measurements' ? `<button data-act="preview">Preview side by side</button>` : ''}
      ${can ? `<button data-act="approve" class="approve">Approve</button><button data-act="reject" class="danger">Reject</button>` : ''}
    </div>
  </div>`;
}
async function renderProposals() {
  $('drawerTitle').textContent = 'Proposals';
  const body = $('drawerBody');
  try { await refreshProposals(); } catch (e) { body.innerHTML = `<p class="muted">${esc(errMsg(e))}</p>`; return; }
  body.innerHTML = state.proposals.length ? state.proposals.map(proposalCard).join('') : '<p class="muted">No proposals here.</p>';
  if (!state.editable) body.insertAdjacentHTML('afterbegin', '<p class="muted small">Only Michael can approve or reject (signed in with a passkey).</p>');
  body.querySelectorAll('.card button[data-act]').forEach((b) => (b.onclick = () => proposalAction(Number(b.closest('.card').dataset.id), b.dataset.act)));
}
async function previewProposal(id) {
  const p = state.proposals.find((x) => x.id === id);
  state.previews.delete(id);
  try { state.previews.set(id, await api.preview(id)); } catch (e) { return toast(`Preview failed: ${errMsg(e)}`, true); }
  const base = p.target.kind === 'workspace' ? p.target.workspace.id : p.target.copyFrom?.id;
  if (p.target.kind === 'current' && state.house?.hasCurrent) await show(0, 'cur');
  else if (base != null) await openTab(base, 0);
  if (state.panes.length < 2) setSplit(true, `pv:${id}`); else await show(1, `pv:${id}`);
  prefs.sync = true; $('syncToggle').checked = true; savePrefs();
  syncFrom(state.panes[0]);
}
async function proposalAction(id, act) {
  const p = state.proposals.find((x) => x.id === id);
  if (act === 'preview') return previewProposal(id);
  try {
    if (act === 'approve') {
      if (!confirm(`Approve “${p.title}”?\n\nThis applies ${p.changes.length} change(s) as a new revision. You can roll it back from History.`)) return;
      const r = await api.approve(id);
      state.previews.delete(id);
      if (r.workspaceId == null) {
        toast(p.kind === 'measurements' ? `Approved. Recorded ${r.measurements?.length ?? 0} measurement(s) in Current.` : `Approved. Current is now at revision ${r.revision}. Roll it back from Current's History if needed.`);
        await refreshHouse();
      }
      else {
        toast(`Approved. Applied as revision ${r.revision} of ${wsName(r.workspaceId) || 'the new workspace'}.`);
        await refreshList(); await openTab(r.workspaceId, 0); await rerenderWs(r.workspaceId);
      }
      if (state.panes.length > 1 && keyPv(state.panes[1].key) === id) setSplit(false);
    } else {
      const note = prompt(`Reject “${p.title}”? Optional reason:`, '');
      if (note === null) return;
      await api.reject(id, note || undefined);
      toast('Rejected. Kept for the record; nothing changed.');
      state.previews.delete(id);
      if (state.panes.length > 1 && keyPv(state.panes[1].key) === id) setSplit(false);
    }
    await refreshList(); renderTabs(); renderProposals();
  } catch (e) { toast(errMsg(e), true); }
}
async function renderHistory() {
  if (state.panes[state.focused]?.key === 'cur') return renderCurrentHistory();
  const wsId = focusedWs();
  $('drawerTitle').textContent = wsId != null ? `History · ${wsName(wsId)}` : 'History';
  const body = $('drawerBody');
  if (wsId == null) { body.innerHTML = '<p class="muted">Focus a workspace tab to see its history.</p>'; return; }
  let revs;
  try { revs = await api.history(wsId); } catch (e) { body.innerHTML = `<p class="muted">${esc(errMsg(e))}</p>`; return; }
  const data = state.cache.get(wsId);
  const names = new Map();
  for (const r of data?.rooms ?? []) for (const f of r.furniture) { names.set(`placement:${f.id}`, f.item.name); names.set(`furniture_item:${f.item.id}`, f.item.name); }
  const floor = Math.max(0, ...revs.filter((r) => r.kind === 'seed' || r.kind === 'copy').map((r) => r.number));
  const latest = revs[0]?.number ?? 0;
  body.innerHTML = '<p class="muted small">Append-only. Rolling back adds a new revision; nothing is erased.</p>' + revs.map((r) => {
    const rows = r.changes.filter((c) => c.field && c.field !== 'measurementStatus').slice(0, 40).map((c) =>
      `<div>${esc(c.op)} ${esc(c.entityType.replace('_', ' '))} ${esc(names.get(`${c.entityType}:${c.entityId}`) ?? '#' + c.entityId)} · ${esc(c.field)}: ${c.op === 'create' ? '' : `<span class="before">${esc(fmtVal(c.field, c.before))}</span> → `}${c.op === 'delete' ? '' : `<span class="after">${esc(fmtVal(c.field, c.after))}</span>`}</div>`).join('');
    const canRb = state.editable && r.number < latest && r.number >= floor;
    return `<div class="rev-row"><div><b>Revision ${r.number}</b> <span class="k">${esc(r.kind)}</span> · ${esc(r.agent ?? r.actor)} · ${when(r.createdAt)}</div>
      <div class="muted small">${esc(r.note ?? '')}${r.proposal ? ` (proposal #${r.proposal.id})` : ''}</div>
      ${rows ? `<details><summary>${r.changeCount} change rows</summary>${rows}</details>` : ''}
      ${canRb ? `<button data-rb="${r.number}">Roll back to here</button>` : ''}</div>`;
  }).join('');
  body.querySelectorAll('button[data-rb]').forEach((b) => (b.onclick = async () => {
    const n = Number(b.dataset.rb);
    if (!confirm(`Roll “${wsName(wsId)}” back to revision ${n}?\n\nThis adds a new revision that undoes everything after ${n}. Pinned measurements are kept.`)) return;
    try {
      const r = await api.rollback(wsId, n);
      toast(`Rolled back. Now at revision ${r.revision}${r.skipped.length ? ` (kept ${r.skipped.length} pinned/used value(s))` : ''}.`);
      await rerenderWs(wsId);
    } catch (e) { toast(errMsg(e), true); }
  }));
}

// ---------------------------------------------------------------------------
// Undo / redo (per tab). Saved edits are undone by a new revision that reverts them (history is never
// rewritten, and the server refuses if a later edit changed the same values); unsaved offline edits are
// taken off the queue; measurements are withdrawn or restored.
// ---------------------------------------------------------------------------
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function recordUndo(key, entry) { if (!key) return; state.undo.of(key).record(entry); renderUndo(); }
function renderUndo() {
  const key = state.panes[state.focused]?.key, h = key && (keyWs(key) != null || key === 'cur') ? state.undo.of(key) : null;
  const u = h?.peekUndo(), r = h?.peekRedo();
  $('btnUndo').disabled = !u || state.undoBusy; $('btnRedo').disabled = !r || state.undoBusy;
  $('btnUndo').title = u ? `Undo: ${u.label ?? 'last edit'} (${MAC ? '⌘Z' : 'Ctrl+Z'})` : `Nothing to undo in this tab (${MAC ? '⌘Z' : 'Ctrl+Z'})`;
  $('btnRedo').title = r ? `Redo: ${r.label ?? 'edit'} (${MAC ? '⇧⌘Z' : 'Ctrl+Y'})` : `Nothing to redo in this tab (${MAC ? '⇧⌘Z' : 'Ctrl+Y or Ctrl+Shift+Z'})`;
}
const undoDeps = {
  async revert(wsId, revision) {
    for (let attempt = 0; ; attempt++) {
      const ws = await loadWs(wsId, attempt > 0);
      try { return await api.revert(wsId, ws.revision, revision); }
      catch (e) { if (attempt === 0 && e instanceof ApiError && e.body?.error === 'conflict') continue; throw e; } // reload once; field checks still apply
    }
  },
  dropDraft: (d) => { const ok = dropDraft(d); if (ok) drawLocal(d, 'before'); return ok; },
  queueDraft: (d) => { queueDraft(d); drawLocal(d, 'after'); },
  withdraw: (id, withdrawn, restoreIn, workspaceId) => api.withdrawMeasurement(id, { withdrawn, restoreIn, workspaceId }),
  pin: (body, valueIn) => api.measure({ ...body, valueIn, action: 'pin' }),
};
/** Offline: put moved pieces back (or forward) on screen, since there is no server copy to reload. */
function drawLocal(d, which) {
  const ws = state.cache.get(d.wsId); if (!ws || !d.local?.length) return;
  for (const r of ws.rooms) for (const p of r.furniture) for (const l of d.local) if (l.id === p.id) p[l.field] = l[which];
  state.panes.forEach((p, i) => { if (keyWs(p.key) === d.wsId) show(i, p.key); });
}
async function undoStep(dir) {
  if (!state.editable || state.undoBusy) return;
  const key = state.panes[state.focused]?.key;
  if (!key || (keyWs(key) == null && key !== 'cur')) return;
  const h = state.undo.of(key), from = dir === 'undo' ? h.undo : h.redo, to = dir === 'undo' ? h.redo : h.undo;
  const e = from.pop();
  if (!e) { toast(dir === 'undo' ? 'Nothing to undo in this tab' : 'Nothing to redo in this tab'); return; }
  state.undoBusy = true; renderUndo();
  $('saveStatus').textContent = dir === 'undo' ? 'Undoing…' : 'Redoing…';
  try {
    const back = await applyEntry(e, undoDeps);
    if (back) to.push(back);
    $('saveStatus').textContent = back?.kind === 'rev' ? `${dir === 'undo' ? 'Undone' : 'Redone'} as revision ${back.revision} · ${new Date().toLocaleTimeString()}` : back ? `${dir === 'undo' ? 'Undone' : 'Redone'}` : 'Nothing left to change.';
    toast(`${dir === 'undo' ? 'Undid' : 'Redid'}: ${e.label ?? 'edit'}`);
  } catch (err) {
    if (err instanceof ApiError) {
      $('saveStatus').textContent = 'Not changed.';
      toast(`Can't ${dir} “${e.label ?? 'edit'}”: ${errMsg(err)}`, true); // e.g. changed since on another device; dropped
    } else { from.push(e); toast(`Can't ${dir} while offline. Try again when you're connected.`, true); }
  } finally {
    state.undoBusy = false;
    const sel = state.selection?.id, wsId = keyWs(key);
    if (wsId != null) await rerenderWs(wsId).catch(() => {}); else await refreshHouse().catch(() => {});
    if (sel) state.panes[state.focused]?.view.select(sel);
    renderUndo();
  }
}
async function proposeAsCurrent(wsId) {
  const ws = state.cache.get(wsId);
  if (!confirm(`Make “${ws?.name ?? wsName(wsId)}” Current's furniture?\n\nThis files a proposal (nothing changes yet). Approving it in Proposals makes the pieces marked existing or keep, and this design's colors, what Current has in these rooms now. Current's old pieces there are replaced. Pieces marked new, replace or remove are left out. This workspace isn't changed. You can roll Current back from its History.\n\nTip: approve or reject this workspace's other pending proposals first, so they're included.`)) return;
  try {
    const p = await api.proposeAsCurrent(wsId);
    toast(`Filed proposal #${p.id}. Review and approve it in Proposals.`);
    $('propFilter').value = 'pending';
    if (state.drawer !== 'proposals') openDrawer('proposals'); else renderProposals();
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
for (const c of CATALOG) {
  const b = document.createElement('button');
  b.innerHTML = `${esc(c.name)}<small>${c.w}" × ${c.d}"${c.kind === 'rug' ? '' : ` × ${c.h}"`}${c.price ? ' · $' + c.price : ''}</small>`;
  b.onclick = () => addPiece(c);
  $('catalogList').appendChild(b);
}
$('customForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = (id) => $(id).value;
  const spec = { kind: 'box', name: v('cName').trim() || 'Custom box', w: +v('cW'), d: +v('cD'), h: +v('cH'), color: v('cColor') };
  if (spec.w > 0 && spec.d > 0 && spec.h > 0) addPiece(spec);
});
const fv = () => state.panes[state.focused]?.view;
$('btnRotate').onclick = () => fv()?.rotateSelected();
$('btnUndo').onclick = () => undoStep('undo');
$('btnRedo').onclick = () => undoStep('redo');
function deleteSelected() {
  const p = state.selection, wsId = focusedWs();
  if (!p || wsId == null || !state.editable) return;
  if (!confirm(`Delete “${p.item.name}” from this design? (You can roll it back from History.)`)) return;
  saveOps(wsId, [{ op: 'delete', entityType: 'placement', entityId: p.id }], `Removed ${p.item.name}`);
}
$('btnDelete').onclick = deleteSelected;
$('actionSel').onchange = (e) => { const p = state.selection, wsId = focusedWs(); if (p && wsId != null) saveOps(wsId, [{ op: 'update', entityType: 'placement', entityId: p.id, field: 'action', value: e.target.value }], `Marked ${p.item.name} ${e.target.value}`); };
function setModeAll(mode) {
  prefs.mode = mode; savePrefs();
  const targets = prefs.sync ? state.panes : [state.panes[state.focused]];
  targets.forEach((p) => p.view.setMode(mode));
  $('btn3d').classList.toggle('active', mode === '3d'); $('btnTop').classList.toggle('active', mode === 'top');
  syncFrom(state.panes[state.focused]);
}
$('btn3d').onclick = () => setModeAll('3d');
$('btnTop').onclick = () => setModeAll('top');
function setWalls(w) { prefs.walls = w; savePrefs(); state.panes.forEach((p) => (p.view.walls = w)); $('btnWalls').textContent = w === 'full' ? "Walls: full – near walls auto-cut" : "Walls: cutaway (3')"; }
$('btnWalls').onclick = () => setWalls(prefs.walls === 'full' ? 'cut' : 'full');
$('snapToggle').onchange = (e) => { prefs.snap = e.target.checked; savePrefs(); state.panes.forEach((p) => (p.view.snap = prefs.snap)); };
$('labelToggle').onchange = (e) => { prefs.labels = e.target.checked; savePrefs(); $('panes').classList.toggle('hide-labels', !prefs.labels); };
$('syncToggle').onchange = (e) => { prefs.sync = e.target.checked; savePrefs(); syncFrom(state.panes[state.focused]); };
$('btnSplit').onclick = () => setSplit(state.panes.length < 2);
$('btnNew').onclick = (e) => { e.stopPropagation(); renderNewMenu(); $('newMenu').hidden = !$('newMenu').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('newMenu').hidden = true; });
$('btnProposals').onclick = () => openDrawer('proposals');
$('btnHistory').onclick = () => openDrawer('history');
$('btnPairPhone').onclick = showPairDialog;
$('drawerClose').onclick = () => openDrawer(state.drawer);
$('propFilter').onchange = renderProposals;
$('btnExport').onclick = () => {
  const data = state.panes[state.focused]?.data; if (!data) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${(data.name || 'workspace').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('toggleSidebar').onclick = () => $('sidebar').classList.toggle('collapsed');
window.addEventListener('keydown', (e) => {
  const step = shortcutFor(e, document.activeElement);
  if (step) { e.preventDefault(); undoStep(step); return; }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'r' || e.key === 'R') fv()?.rotateSelected();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') fv()?.select(null);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try { state.me = await api.me(); } catch (e) {
    if (e instanceof ApiError && e.status === 401) { $('signin').hidden = false; $('whoami').textContent = 'Signed out'; return; }
    $('whoami').textContent = `Can't reach the server: ${errMsg(e)}`; return;
  }
  state.editable = state.me.kind === 'user';
  document.body.classList.toggle('readonly', !state.editable);
  $('whoami').textContent = state.editable ? 'Signed in as Michael · edits save as revisions' : `Read-only (agent key, ${state.me.scope} scope)`;
  state.house = await api.house();
  try { state.templates = await api.templates(); setTemplates(state.templates); } catch { /* older server */ }
  $('houseStatus').hidden = !!state.house.hasCurrent;
  if (!state.house.hasCurrent) $('houseStatus').innerHTML = '<strong>No Current yet.</strong> Create one from a scan or confirmed measurements. Until then, designs live in workspaces like the Test room.';
  await refreshList();
  $('snapToggle').checked = prefs.snap; $('labelToggle').checked = prefs.labels; $('syncToggle').checked = prefs.sync;
  $('panes').classList.toggle('hide-labels', !prefs.labels);
  if (params.get('mode')) prefs.mode = params.get('mode') === 'top' ? 'top' : '3d';
  if (params.get('sync')) prefs.sync = params.get('sync') !== '0';
  $('btn3d').classList.toggle('active', prefs.mode === '3d'); $('btnTop').classList.toggle('active', prefs.mode === 'top');
  setWalls(prefs.walls);
  state.panes.push(makePane(0));
  const first = Number(params.get('ws')) || state.openTabs[0];
  if (params.get('ws') === 'cur' && state.house.hasCurrent) await show(0, 'cur');
  else if (first) await openTab(first, 0);
  else { $('panes').innerHTML = '<p class="muted" style="padding:20px">No workspaces yet.</p>'; }
  await refreshProposals().catch(() => {});
  $('btnPairPhone').disabled = !state.editable;
  if (!state.editable) $('btnPairPhone').title = 'Only Michael can pair a phone (passkey session)';
  await refreshScans();
  const split = params.get('split');
  if (split) {
    if (split.startsWith('pv:')) { await openDrawerSilently(); await previewProposal(Number(split.slice(3))); }
    else setSplit(true, split);
  }
  if (params.get('drawer')) openDrawer(params.get('drawer'));
  flushDrafts();
}

// ---------------------------------------------------------------------------
// Pairing and scans
// ---------------------------------------------------------------------------
function modal(html) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="modal-content">${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
  document.body.appendChild(m);
  return m;
}
async function qrSvg(text) {
  try {
    const QR = (await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm')).default;
    return await QR.toString(text, { type: 'svg', margin: 1, width: 220 });
  } catch { return ''; } // offline: the code and link below still work
}
function showPairDialog() {
  if (!state.editable) return toast('Only Michael can pair a phone (sign in with your passkey)', true);
  const rooms = state.house?.current?.rooms ?? [];
  const m = modal(`<h2>Pair phone</h2>
    <p class="small">The code works for one scan (plus its photos), from one phone, for 60 minutes. The scan waits here for your review; nothing changes Current until you promote it.</p>
    <label>What are you scanning?
      <select id="pairScope">
        <option value="new">A new room</option>
        ${rooms.map((r) => `<option value="${r.id}">Rescan ${esc(r.label)} (Current)</option>`).join('')}
      </select>
    </label>
    <label id="pairLabelRow">Room name <input id="pairLabel" value="Family room" maxlength="120"></label>
    <div class="row"><button id="pairGo" class="primary">Create code</button><button data-close>Cancel</button></div>`);
  const scope = m.querySelector('#pairScope');
  scope.onchange = () => (m.querySelector('#pairLabelRow').hidden = scope.value !== 'new');
  m.querySelector('#pairGo').onclick = async () => {
    const body = scope.value === 'new' ? { newRoom: true, label: m.querySelector('#pairLabel').value.trim() } : { roomId: Number(scope.value) };
    let r;
    try { r = await api.pairPhone(body); } catch (e) { return toast(errMsg(e), true); }
    const url = `${location.origin}/scan?token=${encodeURIComponent(r.token)}`;
    const svg = await qrSvg(url);
    m.querySelector('.modal-content').innerHTML = `<h2>Scan with your iPhone</h2>
      <p class="small">Point the iPhone Camera at the code to open House Planner, or type the code in the app. Take the guided photos before you send the scan.</p>
      ${svg ? `<div style="text-align:center">${svg}</div>` : ''}
      <div class="code-box">${esc(r.token)}</div>
      <p class="small">Scanning: <b>${esc(r.roomLabel)}</b> · expires ${when(r.expiresAt)}<br><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>
      <div class="row"><button data-close>Done</button></div>`;
  };
}
async function refreshScans() {
  const el = $('scanImports');
  let done = [];
  try { state.scans = await api.scans('pending'); done = (await api.scans('promoted')).slice(0, 5); } catch (e) { el.innerHTML = `<div class="muted">${esc(errMsg(e))}</div>`; return; }
  const item = (s, label) => `<div class="scan-item"><strong>${esc(s.label)}</strong>
        <span class="muted">${label} · ${when(s.createdAt)} · ${s.files} file(s)</span>
        <div class="row"><button data-scan="${s.id}">${s.status === 'pending' ? 'Review' : 'Open'}</button></div></div>`;
  el.innerHTML = (state.scans.length
    ? state.scans.map((s) => item(s, s.room ? `Rescan of ${esc(s.room.label)}` : 'New room')).join('')
    : '<div class="muted">No scans waiting for review.</div>')
    + (done.length ? `<div class="muted" style="margin-top:6px">Promoted</div>${done.map((s) => item(s, `#${s.id} in ${esc(s.room?.label ?? '?')}`)).join('')}` : '');
  el.querySelectorAll('button[data-scan]').forEach((b) => (b.onclick = () => reviewScan(Number(b.dataset.scan))));
}
async function reviewScan(id) {
  let scan;
  try { scan = await api.scan(id); } catch (e) { return toast(`Couldn't load scan: ${errMsg(e)}`, true); }
  state.scanPreviews.set(id, scan);
  if (state.house?.hasCurrent) await show(0, 'cur');
  if (state.panes.length < 2) setSplit(true, `sc:${id}`); else await show(1, `sc:${id}`);
  state.drawer = null; openDrawer('scan', id);
}
function renderScanReview(id) {
  const scan = state.scanPreviews.get(id), body = $('drawerBody');
  $('drawerTitle').textContent = 'Review scan';
  if (!scan) { body.innerHTML = '<p class="muted">Scan not loaded.</p>'; return; }
  const s = scan.parsed;
  const can = state.editable && scan.status === 'pending';
  const objRows = s.objects.map((o) => `<tr><td>${esc(o.label ?? o.kind)}</td><td>${fmtIn(o.widthIn)} × ${fmtIn(o.depthIn)} × ${fmtIn(o.heightIn)}</td><td>${o.template ? esc(o.template.name) : '<span class="muted">no template</span>'}</td></tr>`).join('');
  body.innerHTML = `<div class="card">
    <div class="meta"><span class="status ${scan.status}">${scan.status}</span> #${scan.id} · ${when(scan.createdAt)}${scan.planFrame === 1 ? ' · older parser (mirror image)' : ''}</div>
    <h3>${esc(scan.label)}</h3>
    <div class="meta">${scan.room ? `${scan.status === 'pending' ? 'Rescan of' : 'Room:'} “${esc(scan.room.label)}”` : 'Creates a new Current room'}</div>
    <p>${fmtIn(s.widthIn)} × ${fmtIn(s.depthIn)} · ceiling ${fmtIn(s.ceilingIn)} · ${s.walls.length} walls · ${s.openings.length} doors/windows/openings · ${s.objects.length} objects</p>
    <b>Photos (${scan.photos?.length ?? 0})</b>
    ${scan.photos?.length ? `<div class="photo-grid">${scan.photos.map((ph) => `<a href="${esc(ph.url)}" target="_blank" rel="noopener"><img src="${esc(ph.url)}" alt="${esc(ph.prompt ?? 'Photo')}" loading="lazy"><div class="photo-cap">${esc(ph.prompt ?? '')}${ph.note ? ` · ${esc(ph.note)}` : ''}${ph.tags?.length ? ` · ${esc(ph.tags.join(', '))}` : ''}</div></a>`).join('')}</div>` : '<p class="muted small">No photos came with this scan.</p>'}
    ${s.objects.length ? `<b>Objects → closest template</b><table class="objs">${objRows}</table>` : ''}
    <p class="small muted">Promoting writes one revision to Current and records every scanned value as a measurement. Pinned measurements always win. You can roll it back from Current's history. Furniture isn't imported on promote; use “Furnish from scan” for a workspace with template pieces.</p>
    <div class="actions">${can ? `<button data-act="promote" class="approve">Promote to Current</button><button data-act="reject" class="danger">Reject</button>` : ''}
      ${state.editable && scan.status === 'promoted' ? `<button data-act="furnish" ${scan.canFurnish ? '' : 'disabled title="Only the scan that created the room, once the room is the right way round"'}>Furnish from scan</button>` : ''}</div>
  </div>`;
  body.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = () => scanAction(id, b.dataset.act)));
}
async function scanAction(id, act) {
  const scan = state.scanPreviews.get(id);
  try {
    if (act === 'furnish') {
      const name = prompt('Name for the new workspace with these pieces', `${scan.label} furniture`)?.trim();
      if (!name) return;
      const r = await api.furnishScan(id, name);
      toast(`Created a workspace with ${r.placements} piece(s)${r.skipped.length ? `; skipped ${r.skipped.length}` : ''}.`);
      await refreshList(); await openTab(r.workspaceId, 0);
      if (state.drawer === 'scan') openDrawer('scan');
      return;
    }
    if (act === 'promote') {
      if (!confirm(`Promote “${scan.label}” to Current?`)) return;
      const r = await api.promoteScan(id);
      toast(`Promoted as Current revision ${r.revision}${r.kept?.length ? ` · kept ${r.kept.length} pinned/used value(s)` : ''}.`);
    } else {
      const note = prompt(`Reject “${scan.label}”? Optional reason:`, '');
      if (note === null) return;
      await api.rejectScan(id, note || undefined);
      toast('Scan rejected. Kept for the record; nothing changed.');
    }
    closeTab(`sc:${id}`);
    await refreshHouse();
    if (act === 'promote') await show(0, 'cur');
    if (state.drawer === 'scan') openDrawer('scan'); // closes the review drawer
    await refreshScans();
  } catch (e) { toast(errMsg(e), true); }
}
async function refreshHouse() {
  state.house = await api.house();
  $('houseStatus').hidden = !!state.house.hasCurrent;
  for (let i = 0; i < state.panes.length; i++) if (state.panes[i].key === 'cur') await show(i, 'cur');
  renderTabs();
}
async function renderCurrentHistory() {
  $('drawerTitle').textContent = 'History · Current';
  const body = $('drawerBody');
  let revs;
  try { revs = await api.currentHistory(); } catch (e) { body.innerHTML = `<p class="muted">${esc(errMsg(e))}</p>`; return; }
  const latest = revs[0]?.number ?? 0;
  body.innerHTML = '<p class="muted small">Current changes only through promoted scans, measurements, proposals you approve (furniture and colors) and rollbacks. Rolling back adds a new revision; pinned values are kept.</p>' + revs.map((r) => {
    const rows = r.changes.filter((c) => c.field && c.field !== 'measurementStatus').slice(0, 40).map((c) =>
      `<div>${esc(c.op)} ${esc(c.entityType.replace('_', ' '))} #${c.entityId} · ${esc(c.field)}: ${c.op === 'create' ? '' : `<span class="before">${esc(fmtVal(c.field, c.before))}</span> → `}${c.op === 'delete' ? '' : `<span class="after">${esc(fmtVal(c.field, c.after))}</span>`}</div>`).join('');
    return `<div class="rev-row"><div><b>Revision ${r.number}</b> <span class="k">${esc(r.kind)}</span> · ${esc(r.agent ?? r.actor)} · ${when(r.createdAt)}</div>
      <div class="muted small">${esc(r.note ?? '')}</div>
      ${rows ? `<details><summary>${r.changeCount} change rows</summary>${rows}</details>` : ''}
      ${state.editable && r.number < latest && r.number >= 1 ? `<button data-rb="${r.number}">Roll back to here</button>` : ''}</div>`;
  }).join('');
  body.querySelectorAll('button[data-rb]').forEach((b) => (b.onclick = async () => {
    const n = Number(b.dataset.rb);
    if (!confirm(`Roll Current back to revision ${n}?\n\nThis adds a new revision that undoes everything after ${n}. Pinned measurements are kept.`)) return;
    try {
      const r = await api.rollbackCurrent(n);
      toast(`Rolled back. Current is now at revision ${r.revision}${r.skipped?.length ? ` (kept ${r.skipped.length} pinned/used value(s))` : ''}.`);
      await refreshHouse(); renderCurrentHistory();
    } catch (e) { toast(errMsg(e), true); }
  }));
}

async function openDrawerSilently() { state.proposals = await api.proposals(); }
boot();

window.housePlanner = { state, show, setSplit, syncFrom, openDrawer, previewProposal, showPairDialog, reviewScan, renderRoomPhotos };
