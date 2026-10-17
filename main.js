// House planner editor: workspaces as tabs, split view with synced cameras, proposals, history,
// measurements. All data comes from and goes to the API; every edit is a revision.
import { CATALOG } from './catalog.js';
import { RoomView, escapeHtml as esc, footprintFt } from './scene.js';
import { api, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
const LS = { tabs: 'hp.tabs.v1', drafts: 'hp.drafts.v1', prefs: 'hp.prefs.v1' };
const params = new URLSearchParams(location.search);
const prefs = Object.assign({ sync: true, mode: '3d', walls: 'cut', snap: true, labels: true }, JSON.parse(localStorage.getItem(LS.prefs) || '{}'));
const savePrefs = () => localStorage.setItem(LS.prefs, JSON.stringify(prefs));

const state = {
  me: null, editable: false, house: null, workspaces: [], cache: new Map(), previews: new Map(),
  openTabs: JSON.parse(localStorage.getItem(LS.tabs) || 'null'), panes: [], focused: 0,
  drawer: null, proposals: [], selection: null,
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
  const pending = state.workspaces.reduce((a, w) => a + w.pendingProposals, 0) + (await api.proposals('pending')).filter((p) => p.target.kind === 'new_workspace').length;
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
  state.selection = null; renderSelection(); renderTabs();
  if (state.drawer === 'history') renderHistory();
}

async function show(i, key) {
  const pane = state.panes[i]; pane.key = key;
  const wsId = keyWs(key), pvId = keyPv(key);
  let data, editable = false, highlight = [];
  try {
    if (wsId != null) { data = await loadWs(wsId); editable = state.editable; }
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
  head.querySelector('.rev').textContent = pvId != null ? '' : `rev ${data.revision}`;
  const tools = head.querySelector('.tools');
  tools.innerHTML = pvId != null
    ? `<span class="chip">preview, not saved</span>`
    : editable ? '' : `<span class="chip ro">read-only</span>`;
  if (state.panes.length > 1 && i === 1) {
    const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Close split'; x.onclick = (e) => { e.stopPropagation(); setSplit(false); };
    tools.appendChild(x);
  }
  renderTabs();
  if (i === state.focused) { state.selection = null; renderSelection(); }
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
const tabKeys = () => [...state.openTabs.map((id) => `ws:${id}`), ...[...state.previews.keys()].map((id) => `pv:${id}`)];
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
    const wsId = keyWs(key), pvId = keyPv(key);
    t.className = 'tab' + (pvId != null ? ' preview' : '') + (state.panes[state.focused]?.key === key ? ' active' : shown.has(key) ? ' shown' : '');
    t.setAttribute('role', 'tab');
    const label = wsId != null ? wsName(wsId) : `Preview #${pvId}`;
    t.innerHTML = `<span class="t">${esc(label)}</span><span class="x" title="Close tab">✕</span>`;
    t.title = wsId != null && state.editable ? 'Double-click to rename' : label;
    t.onclick = (e) => { if (e.target.classList.contains('x')) return; show(state.focused, key); };
    t.ondblclick = () => wsId != null && renameWs(wsId);
    t.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(key); };
    tabs.appendChild(t);
  }
}
function closeTab(key) {
  const wsId = keyWs(key), pvId = keyPv(key);
  if (wsId != null) {
    if (state.openTabs.length <= 1 && !state.previews.size) return toast('Keep at least one tab open');
    state.openTabs = state.openTabs.filter((id) => id !== wsId); saveTabs();
  } else state.previews.delete(pvId);
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
  add('Blank workspace', () => createWs());
  const sep = document.createElement('div'); sep.className = 'sep'; m.appendChild(sep);
  for (const w of state.workspaces) add(`Copy of “${w.name}”`, () => createWs(w.id, `${w.name} (copy)`));
  const cur = document.createElement('div'); cur.className = 'disabled';
  cur.textContent = state.house?.hasCurrent ? 'Copy from Current' : 'Copy from Current (no Current yet)';
  m.appendChild(cur);
}
async function createWs(copyFrom, suggested) {
  const name = prompt('Name for the new workspace', suggested || 'New design')?.trim();
  if (!name) return;
  try {
    const ws = await api.createWorkspace(name, copyFrom);
    state.cache.set(ws.id, ws); await refreshList();
    await openTab(ws.id);
    toast(`Created “${ws.name}”`);
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Editing (every edit = a revision; Michael's own edits count as approved)
// ---------------------------------------------------------------------------
async function saveOps(wsId, changes, note) {
  const ws = await loadWs(wsId);
  $('saveStatus').textContent = 'Saving…';
  try {
    const r = await api.save(wsId, ws.revision, changes, note);
    $('saveStatus').textContent = r.unchanged ? 'No change.' : `Saved as revision ${r.revision} · ${new Date().toLocaleTimeString()}`;
    clearDraft(wsId);
    await rerenderWs(wsId);
    return r;
  } catch (e) {
    if (e instanceof ApiError) {
      $('saveStatus').textContent = 'Not saved.';
      toast(e.status === 409 && e.body?.error === 'conflict' ? 'This workspace changed on another device. Reloaded the latest.' : `Not saved: ${errMsg(e)}`, true);
      await rerenderWs(wsId);
    } else {
      keepDraft(wsId, ws.revision, changes, note);
      $('saveStatus').textContent = 'Offline: kept as a draft on this device; it will be saved when you reconnect.';
    }
  }
}
function drafts() { return JSON.parse(localStorage.getItem(LS.drafts) || '[]'); }
function keepDraft(wsId, baseRevision, changes, note) { localStorage.setItem(LS.drafts, JSON.stringify([...drafts(), { wsId, baseRevision, changes, note }])); }
function clearDraft(wsId) { localStorage.setItem(LS.drafts, JSON.stringify(drafts().filter((d) => d.wsId !== wsId))); }
async function flushDrafts() {
  const list = drafts(); if (!list.length || !state.editable) return;
  localStorage.setItem(LS.drafts, '[]');
  for (const d of list) {
    try { await api.save(d.wsId, d.baseRevision, d.changes, d.note); toast('Saved your offline edits'); }
    catch (e) { if (!(e instanceof ApiError)) { keepDraft(d.wsId, d.baseRevision, d.changes, d.note); return; } toast(`An offline edit couldn't be saved: ${errMsg(e)}`, true); }
  }
  for (const id of new Set(list.map((d) => d.wsId))) if (state.cache.has(id)) await rerenderWs(id);
}
window.addEventListener('online', flushDrafts);

function commitMove(pane, p, before) {
  const wsId = keyWs(pane?.key); if (wsId == null) return;
  const changes = ['xIn', 'yIn', 'rotationDeg'].filter((f) => p[f] !== before[f]).map((f) => ({ op: 'update', entityType: 'placement', entityId: p.id, field: f, value: p[f] }));
  if (changes.length) saveOps(wsId, changes, `Moved ${p.item.name}`);
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
  const can = state.editable && keyWs(state.panes[state.focused]?.key) != null;
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
  const row = btn.closest('.meas'), wsId = focusedWs();
  const body = { workspaceId: wsId, entityType: row.dataset.et, entityId: Number(row.dataset.id), field: row.dataset.field };
  try {
    if (btn.dataset.act === 'unpin') {
      await api.unpin(body); toast('Unpinned. The newest measurement is used again.');
    } else {
      const valueIn = Math.round(Number(row.querySelector('input').value));
      if (!Number.isFinite(valueIn) || valueIn <= 0) return toast('Enter a value in inches', true);
      const r = await api.measure({ ...body, valueIn, action: btn.dataset.act === 'pin' ? 'pin' : 'measured' });
      toast(r.applied ? (btn.dataset.act === 'pin' ? `Pinned at ${fmtIn(valueIn)}. Scans and estimates won't change it.` : `Saved ${fmtIn(valueIn)} as measured`) : `Recorded, but the pinned value (${fmtIn(r.effective.valueIn)}) still wins`);
    }
    const sel = state.selection?.id;
    await rerenderWs(wsId);
    if (sel) state.panes[state.focused].view.select(sel);
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Drawer: proposals and history
// ---------------------------------------------------------------------------
function openDrawer(kind) {
  state.drawer = state.drawer === kind ? null : kind;
  $('drawer').hidden = !state.drawer;
  $('btnProposals').classList.toggle('active', state.drawer === 'proposals');
  $('btnHistory').classList.toggle('active', state.drawer === 'history');
  $('propFilter').hidden = state.drawer !== 'proposals';
  if (state.drawer === 'proposals') renderProposals();
  if (state.drawer === 'history') renderHistory();
  window.dispatchEvent(new Event('resize'));
}
function diffRow(c) {
  const what = `${esc(c.entityType.replace('_', ' '))} ${esc(c.label ?? '')}${c.entityId ? ` <span class="meta">#${c.entityId}</span>` : ''}`;
  if (c.op === 'update') return `<tr><td>${what}<br><span class="meta">${esc(c.field)}</span></td><td><span class="before">${esc(fmtVal(c.field, c.before))}</span> → <span class="after">${esc(fmtVal(c.field, c.after))}</span></td></tr>`;
  if (c.op === 'delete') return `<tr><td>${what}</td><td><span class="before">delete</span></td></tr>`;
  const f = Object.entries(c.fields ?? {}).map(([k, v]) => `${esc(k)}: ${esc(fmtVal(k, v))}`).join(', ');
  return `<tr><td>new ${esc(c.entityType.replace('_', ' '))} ${esc(c.label ?? '')}</td><td><span class="after">${f}</span></td></tr>`;
}
function proposalCard(p) {
  const target = p.target.kind === 'new_workspace'
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
    <b>Changes</b><table class="diff">${p.changes.map(diffRow).join('')}</table>
    <b>Cost to change: ${usd(p.cost.lowUsd)}–${usd(p.cost.highUsd)}</b>
    <table class="cost"><tr><th>Step</th><th>What changes</th><th class="num">Low–high</th></tr>${steps}</table>
    ${p.decidedAt ? `<div class="meta">Decided ${when(p.decidedAt)}${p.decisionNote ? `: ${esc(p.decisionNote)}` : ''}${p.appliedRevision ? ` · applied as revision ${p.appliedRevision.number}` : ''}</div>` : ''}
    <div class="actions">
      ${p.status === 'pending' ? `<button data-act="preview">Preview side by side</button>` : ''}
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
  if (base != null) await openTab(base, 0);
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
      toast(`Approved. Applied as revision ${r.revision} of ${wsName(r.workspaceId) || 'the new workspace'}.`);
      state.previews.delete(id);
      await refreshList(); await openTab(r.workspaceId, 0); await rerenderWs(r.workspaceId);
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
  if (first) await openTab(first, 0);
  else { $('panes').innerHTML = '<p class="muted" style="padding:20px">No workspaces yet.</p>'; }
  await refreshProposals().catch(() => {});
  const split = params.get('split');
  if (split) {
    if (split.startsWith('pv:')) { await openDrawerSilently(); await previewProposal(Number(split.slice(3))); }
    else setSplit(true, split);
  }
  if (params.get('drawer')) openDrawer(params.get('drawer'));
  flushDrafts();
}
async function openDrawerSilently() { state.proposals = await api.proposals(); }
boot();

window.housePlanner = { state, show, setSplit, syncFrom, openDrawer, previewProposal };
