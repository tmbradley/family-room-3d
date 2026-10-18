// House planner editor. Layout: top bar (where you are, Scan room, Inbox, account), sidebar (Current
// house, which is locked, and designs grouped by room), one toolbar for what is open, the canvas (one
// view, or two in Compare) and the inspector on the right (Details / Proposals / History).
// All data comes from and goes to the API; every edit is a revision.
import { CATALOG } from './catalog.js';
import { RoomView, escapeHtml as esc, footprintFt, setTemplates } from './scene.js';
import { api, ApiError } from './api.js';
import { UndoBook, applyEntry, shortcutFor } from './undo.js';

const $ = (id) => document.getElementById(id);
const LS = { open: 'hp.open.v1', drafts: 'hp.drafts.v1', prefs: 'hp.prefs.v1' };
const params = new URLSearchParams(location.search);
const prefs = Object.assign({ sync: true, mode: '3d', walls: 'cut', snap: true, labels: true }, JSON.parse(localStorage.getItem(LS.prefs) || '{}'));
const savePrefs = () => localStorage.setItem(LS.prefs, JSON.stringify(prefs));

const state = {
  me: null, editable: false, house: null, workspaces: [], cache: new Map(), previews: new Map(), scanViews: new Map(),
  open: null,        // what is open: 'cur' or 'ws:<id>'
  compare: null,     // the other side of Compare: 'cur' | 'ws:<id>' | 'pv:<proposal>' | 'sc:<scan>'
  showing: null,     // proposal id shown on the plan (the open view shows its preview)
  panel: 'details', propScope: 'here', archivedOpen: false,
  panes: [], focused: 0, selection: null,
  proposals: [], scans: [], templates: [],
  saved: new Map(),  // key -> { revision, at } of this tab's last save
  undo: new UndoBook(100), undoBusy: false, // per view undo/redo (in memory, this browser tab only)
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
let toastTimer;
/** A short message; with `undo`, an Undo button for `ms` (default 5 s). */
function toast(msg, err = false, undo = null, ms) {
  const t = $('toast'); t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" id="toastUndo">Undo</button>' : ''}`;
  t.className = err ? 'err' : ''; t.hidden = false;
  if (undo) $('toastUndo').onclick = () => { t.hidden = true; clearTimeout(toastTimer); undo(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms ?? (undo ? 5000 : err ? 6000 : 3000));
}
const fmtIn = (n) => { if (n == null) return '—'; const f = Math.floor(Math.abs(n) / 12), i = Math.abs(n) % 12; return `${n < 0 ? '−' : ''}${f ? `${f}' ` : ''}${i}"`; };
const fmtVal = (field, v) => (v == null ? '∅' : /In$/.test(field || '') && /^-?\d+$/.test(String(v)) ? `${v}" (${fmtIn(Number(v))})` : String(v));
const usd = (n) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const when = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (d) => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
const clock = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function ago(d) {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return day(d);
}
const wsRow = (id) => state.workspaces.find((w) => w.id === id);
const wsName = (id) => wsRow(id)?.name ?? `Design ${id}`;
const keyWs = (key) => (key?.startsWith('ws:') ? Number(key.slice(3)) : null);
const keyPv = (key) => (key?.startsWith('pv:') ? Number(key.slice(3)) : null);
const keySc = (key) => (key?.startsWith('sc:') ? Number(key.slice(3)) : null);
const hasCurrent = () => !!state.house?.hasCurrent;
const currentData = () => ({ id: null, name: 'Current house', revision: state.house.current.revision, units: 'in', rooms: state.house.current.rooms, current: true });
const currentRooms = () => (hasCurrent() ? state.house.current.rooms : []);
const roomLabelOf = (w) => (w?.roomLabels?.length ? w.roomLabels.join(' + ') : 'No rooms');
const currentLabel = () => currentRooms().map((r) => r.label).join(' + ') || 'House';
function errMsg(e) { return e instanceof ApiError ? e.body?.message || e.body?.error || e.message : e?.message || String(e); }
const isArchived = (wsId) => !!wsRow(wsId)?.archived;
const canEditWs = (wsId) => state.editable && wsId != null && !isArchived(wsId);
const pendingFor = (key) => state.proposals.filter((p) => p.status === 'pending' && proposalIsFor(p, key));
function proposalIsFor(p, key) {
  if (key === 'cur') return p.target.kind === 'current';
  const id = keyWs(key);
  return (p.target.kind === 'workspace' && p.target.workspace?.id === id) || (p.target.kind === 'new_workspace' && p.target.copyFrom?.id === id && p.status === 'pending');
}
function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${(name || 'design').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'design'}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadWs(id, force = false) {
  if (!force && state.cache.has(id)) return state.cache.get(id);
  const v = await api.workspace(id);
  state.cache.set(id, v);
  return v;
}
async function refreshList() { state.workspaces = await api.workspaces(); }
async function refreshProposals() { state.proposals = await api.proposals(); }
async function refreshScans() { try { state.scans = await api.scans(); } catch { state.scans = []; } }
async function refreshHouse() {
  state.house = await api.house();
  for (let i = 0; i < state.panes.length; i++) if (state.panes[i].key === 'cur') await showPane(i, 'cur');
}
const liveDesigns = () => state.workspaces.filter((w) => !w.archived);

// ---------------------------------------------------------------------------
// URL: ?design=8|cur & compare=cur|ws:9|pv:12|sc:3 & panel=details|proposals|history & mode & sync.
// Old links (?ws=, ?split=, ?drawer=) still work.
// ---------------------------------------------------------------------------
function readUrl() {
  const d = params.get('design') ?? params.get('ws');
  let open = d === 'cur' ? 'cur' : d && Number(d) ? `ws:${Number(d)}` : null;
  let compare = params.get('compare') ?? params.get('split');
  if (compare && /^\d+$/.test(compare)) compare = `ws:${compare}`;
  if (compare && !/^(cur|ws:\d+|pv:\d+|sc:\d+)$/.test(compare)) compare = null;
  const drawer = params.get('drawer');
  const panel = params.get('panel') ?? (drawer === 'proposals' || drawer === 'history' ? drawer : null);
  if (params.get('mode')) prefs.mode = params.get('mode') === 'top' ? 'top' : '3d';
  if (params.get('sync')) prefs.sync = params.get('sync') !== '0';
  return { open, compare, panel: ['details', 'proposals', 'history'].includes(panel) ? panel : null };
}
function writeUrl() {
  const q = new URLSearchParams();
  if (state.open) q.set('design', state.open === 'cur' ? 'cur' : String(keyWs(state.open)));
  if (state.compare) q.set('compare', state.compare);
  if (state.panel !== 'details') q.set('panel', state.panel);
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
  if (state.open) localStorage.setItem(LS.open, state.open);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
/** Open Current ('cur') or a design ('ws:<id>'). Compare with Current stays on; other comparisons close. */
async function openKey(key, { panel, keepCompare = false } = {}) {
  if (!key) return;
  if (key !== state.open) {
    state.showing = null; state.selection = null;
    if (!keepCompare && state.compare !== 'cur') state.compare = null;
    if (state.compare === key || (key === 'cur' && state.compare === 'cur')) state.compare = null;
  }
  state.open = key;
  if (panel) state.panel = panel;
  closeSide();
  await render();
}
const fallbackKey = () => (hasCurrent() ? 'cur' : liveDesigns()[0] ? `ws:${liveDesigns()[0].id}` : null);
async function render() {
  if (state.open && keyWs(state.open) != null && !wsRow(keyWs(state.open))) state.open = fallbackKey();
  if (state.open === 'cur' && !hasCurrent()) state.open = fallbackKey();
  // Comparing designs uses the full width (as in the mockup); History, Details or a selection bring the inspector back.
  document.body.classList.toggle('noinsp', !!state.inspHidden && !!state.compare && (state.compare === 'cur' || keyWs(state.compare) != null) && !phone());
  renderTop(); renderSide(); renderTool();
  await renderPanes();
  renderInsp(); writeUrl();
}

// ---------------------------------------------------------------------------
// Panes (one, or two in Compare)
// ---------------------------------------------------------------------------
/** The keys shown, left to right. Compare with Current puts Current on the left (before → after). */
function paneKeys() {
  const main = state.showing != null ? `pv:${state.showing}` : state.open;
  if (!main) return [];
  const c = state.compare;
  if (!c) return [main];
  if (c === 'cur') return main === 'cur' ? [main] : ['cur', main];
  if (keySc(c) != null) return hasCurrent() ? ['cur', c] : [c]; // scan review: Current vs the scan
  return [main, c];
}
function makePane() {
  const el = document.createElement('div'); el.className = 'pane';
  el.innerHTML = `<div class="vhead" hidden></div><div class="pane-view"></div>`;
  $('panes').appendChild(el);
  const pane = { el, key: null, data: null };
  pane.view = new RoomView(el.querySelector('.pane-view'), {
    onSelect: (v, p) => {
      if (paneOf(v) !== state.panes[state.focused]) return;
      state.selection = p; renderSelectionLater();
      if (p && state.inspHidden) { state.inspHidden = false; document.body.classList.remove('noinsp'); }
    },
    onCommit: (v, p, before) => commitMove(paneOf(v), p, before),
    onCamera: (v) => syncFrom(paneOf(v)),
    onInteract: (v) => focusPane(state.panes.indexOf(paneOf(v))),
    onFrame: (v) => { if (paneOf(v) === state.panes[state.focused]) placeFloatbar(); },
  });
  applyViewPrefs(pane.view);
  el.addEventListener('pointerdown', () => focusPane(state.panes.indexOf(pane)), { capture: true });
  return pane;
}
const paneOf = (view) => state.panes.find((p) => p.view === view);
function applyViewPrefs(v) { v.walls = prefs.walls; v.snap = prefs.snap; v.setMode(prefs.mode); }
function setPaneCount(n) {
  while (state.panes.length < n) state.panes.push(makePane());
  while (state.panes.length > n) { const p = state.panes.pop(); p.view.dispose(); p.el.remove(); }
  if (state.focused >= n) state.focused = 0;
  requestAnimationFrame(() => state.panes.forEach((p) => p.view.resize()));
}
function focusPane(i) {
  if (i < 0 || i === state.focused) return;
  state.focused = i;
  state.panes.forEach((p, j) => p.el.classList.toggle('focused', j === i && state.panes.length > 1));
  state.selection = null; renderInsp(); renderUndo(); renderTool();
}
const focusedPane = () => state.panes[state.focused];
const focusedKey = () => focusedPane()?.key;
function focusedWs() { return keyWs(focusedKey()); }

/** Data, editability and label of a key. */
async function dataOf(key) {
  if (key === 'cur') return hasCurrent() ? { data: currentData(), editable: false, label: '🔒 Current house', chip: `<span class="chip lock">rev ${state.house.current.revision}</span>` } : null;
  const wsId = keyWs(key), pvId = keyPv(key), scId = keySc(key);
  if (wsId != null) {
    const data = await loadWs(wsId);
    return { data, editable: canEditWs(wsId), label: `◧ ${data.name}`, chip: data.archived ? '<span class="chip arch">archived</span>' : '<span class="chip edit">design</span>' };
  }
  if (pvId != null) {
    if (!state.previews.has(pvId)) state.previews.set(pvId, await api.preview(pvId));
    const data = state.previews.get(pvId);
    return { data, editable: false, label: `Proposal #${pvId}`, chip: '<span class="chip pv">preview, not saved</span>' };
  }
  if (scId != null) {
    if (!state.scanViews.has(scId)) state.scanViews.set(scId, await api.scan(scId));
    const s = state.scanViews.get(scId);
    return { data: s.preview, editable: false, label: `📱 Scan #${scId} · ${s.label ?? ''}`, chip: `<span class="chip ${s.status === 'pending' ? 'edit' : 'ro'}">${esc(s.status)}</span>` };
  }
  return null;
}

let paneSeq = 0;
async function renderPanes() {
  const keys = paneKeys(), seq = ++paneSeq;
  if (!keys.length) {
    setPaneCount(0);
    $('panes').innerHTML = `<div class="empty-canvas"><div><b>Nothing to show yet.</b><br>${state.editable ? 'Scan a room with the iPhone app, or start a new design.' : 'Michael has no rooms or designs yet.'}</div></div>`;
    $('vctl').hidden = true; $('diffbar').hidden = true; $('legend').hidden = true; $('banner').hidden = true; $('floatbar').hidden = true;
    return;
  }
  $('panes').querySelector('.empty-canvas')?.remove();
  $('vctl').hidden = false;
  let infos;
  try { infos = await Promise.all(keys.map(dataOf)); } catch (e) { toast(`Couldn't load: ${errMsg(e)}`, true); return; }
  if (seq !== paneSeq) return;
  const prev = keys.indexOf(focusedKey()), fi = keys.indexOf(state.open);
  setPaneCount(keys.length);
  state.focused = keys.length === 1 ? 0 : prev >= 0 ? prev : fi >= 0 ? fi : keys.length - 1;
  for (let i = 0; i < keys.length; i++) await showPane(i, keys[i], infos[i]);
  state.panes.forEach((p, j) => p.el.classList.toggle('focused', j === state.focused && state.panes.length > 1));
  applyMarks();
  renderCanvasChrome();
  if (keys.length > 1) syncFrom(state.panes[state.focused], true);
}
async function showPane(i, key, info) {
  const pane = state.panes[i]; if (!pane) return;
  info ??= await dataOf(key).catch((e) => { toast(`Couldn't load: ${errMsg(e)}`, true); return null; });
  if (!info) return;
  const keyChanged = pane.key !== key;
  pane.key = key; pane.data = info.data; pane.info = info;
  pane.view.setData(info.data, { editable: info.editable });
  if (keyChanged) pane.view.select(null);
  const head = pane.el.querySelector('.vhead');
  head.hidden = state.panes.length < 2;
  if (!head.hidden) {
    const right = i === state.panes.length - 1;
    head.innerHTML = `<span class="lblbox ${key === state.open ? 'main' : ''}" title="${esc(info.label)}"><span class="lt">${esc(info.label)}</span> ${info.chip}</span><span class="grow"></span>
      ${right ? `<button class="b" data-vh="sync" title="Move both views together" aria-label="Sync cameras">🔗<span class="vh-t"> Sync cameras</span> ${prefs.sync ? '✓' : ''}</button><button class="b" data-vh="close" title="Close the comparison" aria-label="Close">✕<span class="vh-t"> Close</span></button>` : ''}`;
    head.querySelector('[data-vh="sync"]')?.addEventListener('click', () => { prefs.sync = !prefs.sync; savePrefs(); syncFrom(focusedPane(), true); renderPanesHeads(); });
    head.querySelector('[data-vh="close"]')?.addEventListener('click', () => closeCompare());
  }
  if (i === state.focused) {
    const sel = pane.view.selected; state.selection = sel != null ? pane.view.placement(sel) : null;
  }
}
function renderPanesHeads() { state.panes.forEach((p, i) => p.info && showPane(i, p.key, p.info).then(applyMarks)); }
async function rerenderWs(wsId) {
  await loadWs(wsId, true);
  await refreshList();
  state.previews.clear(); // previews are against the old revision
  for (let i = 0; i < state.panes.length; i++) if (keyWs(state.panes[i].key) === wsId) await showPane(i, state.panes[i].key);
  applyMarks(); renderCanvasChrome(); renderSide(); renderTop(); renderTool(); renderInsp();
}
function syncFrom(src, force = false) {
  if (!src || state.panes.length < 2 || !prefs.sync) return;
  const cam = src.view.getCamera();
  for (const p of state.panes) if (p !== src) p.view.setCamera(cam);
}
function closeCompare() { state.compare = null; state.inspHidden = false; render(); }
function setCompare(key) {
  if (!key || key === state.open) return closeCompare();
  state.compare = key; state.showing = null; state.inspHidden = key === 'cur' || keyWs(key) != null;
  prefs.sync = true; savePrefs();
  render();
}

// ---------------------------------------------------------------------------
// What changed: pieces matched by furniture item (copies keep their items), then by placement id.
// ---------------------------------------------------------------------------
const pieces = (data) => (data?.rooms ?? []).flatMap((r) => r.furniture.map((f) => ({ ...f, roomId: r.id })));
const pieceSig = (p) => JSON.stringify([p.xIn, p.yIn, p.rotationDeg, p.action, p.template?.slug ?? null, p.template?.params ?? null, p.model?.id ?? null, p.item?.wIn, p.item?.dIn, p.item?.hIn, p.item?.color]);
function diffViews(a, b) {
  const pa = pieces(a), pb = pieces(b);
  const byItem = new Map(pa.map((p) => [p.itemId, p])), byId = new Map(pa.map((p) => [p.id, p]));
  const used = new Set(), added = [], changed = [], removed = [];
  for (const p of pb) {
    const q = byItem.get(p.itemId) ?? byId.get(p.id);
    if (!q || used.has(q.id)) { added.push(p); continue; }
    used.add(q.id);
    if (pieceSig(p) !== pieceSig(q)) changed.push({ p, q });
  }
  for (const q of pa) if (!used.has(q.id)) removed.push(q);
  const colors = [];
  for (const r of b?.rooms ?? []) {
    const o = (a?.rooms ?? []).find((x) => x.id === r.id); if (!o) continue;
    for (const [k, l] of [['wallColor', 'walls'], ['trimColor', 'trim'], ['deviceColor', 'outlets']]) if ((r[k]?.color ?? null) !== (o[k]?.color ?? null)) colors.push(`${r.label} ${l}`);
    if ((r.floor?.color ?? null) !== (o.floor?.color ?? null)) colors.push(`${r.label} floor`);
  }
  const cents = added.reduce((s, p) => s + (p.item?.priceCents ?? 0), 0);
  return { added, changed, removed, colors, count: added.length + changed.length + removed.length + colors.length, cents };
}
function diffText(d) {
  const moved = (c) => (c.p.xIn !== c.q.xIn || c.p.yIn !== c.q.yIn || c.p.rotationDeg !== c.q.rotationDeg ? 'moved' : 'changed');
  return [...d.added.map((p) => `+ ${p.item.name}`), ...d.removed.map((p) => `− ${p.item.name}`), ...d.changed.map((c) => `${c.p.item.name} ${moved(c)}`), ...d.colors.map((c) => `${c} color`)].join(' · ');
}
/** Highlights: in Compare, "after" pieces green (added) / amber (changed), "before" pieces red (removed). */
function applyMarks() {
  const [a, b] = state.panes;
  if (state.panes.length === 2 && a?.data && b?.data) {
    const d = diffViews(a.data, b.data);
    const mb = {}, ma = {};
    for (const p of d.added) mb[`placement:${p.id}`] = 'added';
    for (const c of d.changed) { mb[`placement:${c.p.id}`] = 'changed'; ma[`placement:${c.q.id}`] = 'changed'; }
    for (const p of d.removed) ma[`placement:${p.id}`] = 'removed';
    a.view.setData(a.data, { editable: a.info.editable, marks: ma });
    b.view.setData(b.data, { editable: b.info.editable, marks: mb });
    state.diff = d;
  } else if (a && state.showing != null && a.data?.preview) {
    // "Show on plan": the proposal's preview, with pieces it removes drawn as red ghosts.
    const base = baseOfProposal(state.showing);
    const d = base ? diffViews(base, a.data) : { added: [], changed: [], removed: [] };
    const touched = new Set(a.data.preview.changedEntities);
    const marks = {};
    for (const p of d.added) marks[`placement:${p.id}`] = 'added';
    for (const c of d.changed) marks[`placement:${c.p.id}`] = 'changed';
    for (const p of pieces(a.data)) if (!marks[`placement:${p.id}`] && (touched.has(`placement:${p.id}`) || touched.has(`furniture_item:${p.itemId}`))) marks[`placement:${p.id}`] = 'changed';
    const ghosts = d.removed.map((p) => ({ ...p, _removed: true }));
    const data = ghosts.length ? { ...a.data, rooms: a.data.rooms.map((r) => ({ ...r, furniture: [...r.furniture, ...ghosts.filter((g) => g.roomId === r.id)] })) } : a.data;
    a.view.setData(data, { editable: false, marks });
    state.diff = d;
  } else state.diff = null;
}
function baseOfProposal(id) {
  const p = state.proposals.find((x) => x.id === id); if (!p) return null;
  if (p.target.kind === 'current') return hasCurrent() ? currentData() : null;
  const ws = p.target.kind === 'workspace' ? p.target.workspace?.id : p.target.copyFrom?.id;
  return ws != null ? state.cache.get(ws) ?? null : null;
}

// ---------------------------------------------------------------------------
// Canvas chrome: banners, legend, diff bar, floating bar, view controls
// ---------------------------------------------------------------------------
function renderCanvasChrome() {
  const banner = $('banner'), keys = paneKeys();
  const main = state.panes.find((p) => p.key === state.open)?.data ?? state.panes[0]?.data;
  banner.hidden = true; banner.className = 'banner';
  const pv = state.showing;
  if (pv != null) {
    const p = state.proposals.find((x) => x.id === pv);
    const d = state.diff;
    const n = d ? d.added.length + d.changed.length + d.removed.length : 0;
    banner.className = 'banner show'; banner.hidden = false;
    banner.innerHTML = `<span>👁 Showing proposal #${pv} on the plan${n ? `: ${n} piece change${n === 1 ? '' : 's'}` : ''}</span>
      <button class="b sm" data-bn="compare">⇆ Compare</button><button class="b sm" data-bn="stop">✕ Stop showing</button>`;
    banner.querySelector('[data-bn="stop"]').onclick = () => { state.showing = null; render(); };
    banner.querySelector('[data-bn="compare"]').onclick = () => compareProposal(pv);
    if (!p) banner.querySelector('[data-bn="compare"]').hidden = true;
  } else if (keys.length === 1 && keyWs(state.open) != null && isArchived(keyWs(state.open))) {
    banner.className = 'banner arch'; banner.hidden = false;
    banner.innerHTML = `<span>This design is archived, so it's read-only.</span>${state.editable ? '<button class="b sm" data-bn="restore">Restore</button>' : ''}`;
    banner.querySelector('[data-bn="restore"]')?.addEventListener('click', () => archiveWs(keyWs(state.open), false));
  } else {
    const mirrored = (main?.rooms ?? []).filter((r) => r.mirrored);
    if (mirrored.length && keys.length === 1) {
      banner.className = 'banner mirror'; banner.hidden = false;
      banner.innerHTML = `<span>${esc(mirrored.map((r) => r.label).join(', '))} came from an older scan and is drawn as a <b>mirror image</b>.</span>${state.editable ? `<button class="b sm" data-bn="mirror">Fix mirror image</button>` : ''}`;
      banner.querySelector('[data-bn="mirror"]')?.addEventListener('click', () => fixMirror(mirrored[0].id));
    }
  }
  $('legend').hidden = !(pv != null || state.panes.length === 2);
  renderDiffbar();
  renderViewControls();
  placeFloatbar(true);
}
function renderDiffbar() {
  const bar = $('diffbar'), d = state.diff;
  bar.hidden = true;
  if (state.panes.length !== 2 || !d) return;
  const [a, b] = state.panes;
  const pvId = keyPv(b.key), scId = keySc(b.key);
  const other = a.key === 'cur' ? 'Current' : a.info?.label?.replace(/^◧ /, '') ?? '';
  const list = diffText(d);
  let right = '';
  if (pvId != null) {
    const p = state.proposals.find((x) => x.id === pvId);
    right = p ? `<b>${usd(p.cost.lowUsd)}–${usd(p.cost.highUsd)}</b>${state.editable && p.status === 'pending' ? `<button class="b primary" data-db="approve">✓ Approve</button><button class="b danger" data-db="reject">✕ Reject</button>` : ''}` : '';
  } else if (scId != null) {
    right = `<button class="b" data-db="review">Review scan</button>`;
  } else {
    const ws = keyWs(b.key);
    right = `${d.cents ? `<b>${usd(d.cents / 100)}</b>` : ''}${a.key === 'cur' && canEditWs(ws) ? '<button class="b primary" data-db="save">⤒ Save to Current…</button>' : ''}`;
  }
  bar.innerHTML = `<b>${scId != null ? `Scan #${scId} vs Current` : `${d.count} change${d.count === 1 ? '' : 's'} vs ${esc(other)}`}</b><span class="meta list" title="${esc(list)}">${esc(list || 'No differences in furniture or colors')}</span>${right}`;
  bar.hidden = false;
  bar.querySelector('[data-db="save"]')?.addEventListener('click', () => openSaveDialog(keyWs(b.key)));
  bar.querySelector('[data-db="approve"]')?.addEventListener('click', () => approve(pvId));
  bar.querySelector('[data-db="reject"]')?.addEventListener('click', () => { state.panel = 'proposals'; renderInsp(); openRejectBox(pvId); });
  bar.querySelector('[data-db="review"]')?.addEventListener('click', () => { state.panel = 'details'; renderInsp(); openInsp(); });
}
function renderViewControls() {
  $('btn3d').classList.toggle('on', prefs.mode === '3d'); $('btnTop').classList.toggle('on', prefs.mode === 'top');
  $('btnWalls').textContent = prefs.walls === 'full' ? 'Walls: full' : 'Walls: cutaway';
  $('btnWalls').title = prefs.walls === 'full' ? 'Full walls; the near walls are cut away automatically' : "Walls cut at 3'";
  $('btnLabels').textContent = prefs.labels ? 'Labels ✓' : 'Labels';
  $('btnLabels').classList.toggle('on', false);
  $('snapToggle').checked = prefs.snap;
  $('panes').classList.toggle('hide-labels', !prefs.labels);
}
let fbLast = '';
function placeFloatbar(force = false) {
  const fb = $('floatbar'), pane = focusedPane(), p = state.selection;
  const show = !!(p && pane?.info?.editable && !p._removed);
  if (!show) { if (!fb.hidden) fb.hidden = true; fbLast = ''; return; }
  const pos = pane.view.screenOf(p.id);
  if (!pos) { fb.hidden = true; return; }
  const cr = $('canvas').getBoundingClientRect(), pr = pane.el.getBoundingClientRect();
  const x = Math.round(Math.min(Math.max(pr.left - cr.left + pos.x, 90), cr.width - 90)), y = Math.round(Math.max(pr.top - cr.top + pos.y, 52));
  const k = `${x},${y}`;
  if (!force && k === fbLast && !fb.hidden) return;
  fbLast = k; fb.style.left = `${x}px`; fb.style.top = `${y}px`; fb.hidden = false;
}

// ---------------------------------------------------------------------------
// Top bar: breadcrumb (click the name to rename), Inbox, account
// ---------------------------------------------------------------------------
function renderTop() {
  const crumb = $('crumb');
  const key = state.open;
  if (!key) { crumb.innerHTML = '<span class="room">No rooms yet</span>'; }
  else if (key === 'cur') {
    crumb.innerHTML = `<span class="room">${esc(currentLabel())}</span><span class="sep">›</span><span class="name">Current house</span><span class="chip lock">🔒 locked</span><span class="rev">rev ${state.house.current.revision}</span>${state.editable ? '' : '<span class="chip ro">read-only</span>'}`;
  } else {
    const id = keyWs(key), w = wsRow(id), data = state.cache.get(id);
    const can = canEditWs(id);
    crumb.innerHTML = `<span class="room">${esc(roomLabelOf(w))}</span><span class="sep">›</span><span class="name ${can ? 'can-rename' : ''}" ${can ? 'title="Click to rename" tabindex="0" role="button"' : ''}>${esc(w?.name ?? data?.name ?? '')}</span>${w?.archived ? '<span class="chip arch">archived</span>' : '<span class="chip edit">design</span>'}<span class="rev">rev ${w?.revision ?? data?.revision ?? ''}</span>${state.editable ? '' : '<span class="chip ro">read-only</span>'}`;
    if (can) {
      const nm = crumb.querySelector('.name');
      nm.onclick = () => startRename(id);
      nm.onkeydown = (e) => { if (e.key === 'Enter') startRename(id); };
    }
  }
  const pendingProps = state.proposals.filter((p) => p.status === 'pending').length;
  const pendingScans = state.scans.filter((s) => s.status === 'pending').length;
  $('inboxN').hidden = !(pendingProps + pendingScans); $('inboxN').textContent = pendingProps + pendingScans;
  $('btnMe').textContent = state.editable ? 'MB' : '👁';
}
function startRename(id) {
  const nm = $('crumb').querySelector('.name'); if (!nm) return;
  const old = wsName(id);
  const inp = document.createElement('input'); inp.value = old; inp.maxLength = 120; inp.setAttribute('aria-label', 'Design name');
  nm.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return; done = true;
    const name = inp.value.replace(/\s+/g, ' ').trim();
    if (!ok || !name || name === old) { renderTop(); return; }
    await saveOps(id, [{ op: 'update', entityType: 'workspace', entityId: id, field: 'name', value: name }], `Renamed to "${name}"`);
    renderTop();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
function togglePop(id, fill) {
  const el = $(id), open = el.hidden;
  closePops();
  if (open) { fill?.(el); el.hidden = false; }
}
function closePops() { document.querySelectorAll('.pop').forEach((p) => { p.hidden = true; if (p.classList.contains('tool-pop')) p.remove(); }); }
document.addEventListener('click', (e) => { if (!e.target.closest('.pop-wrap') && !e.target.closest('.pop')) closePops(); });
function fillInbox(el) {
  const props = state.proposals.filter((p) => p.status === 'pending');
  const scans = state.scans.filter((s) => s.status === 'pending');
  const target = (p) => (p.target.kind === 'current' ? 'Current house' : p.target.kind === 'new_workspace' ? `new design from ${p.target.copyFrom?.name ?? '?'}` : p.target.workspace?.name ?? 'a design');
  el.innerHTML = `<div class="hd">Proposals waiting for you</div>${props.length ? props.map((p) => `<button class="mi" data-ib-p="${p.id}">#${p.id} ${esc(p.title)}<small>${esc(target(p))} · by ${esc(p.agent ?? p.createdBy)} · ${when(p.createdAt)}</small></button>`).join('') : '<div class="empty">No pending proposals.</div>'}
    <div class="sep"></div><div class="hd">Scans waiting for review</div>${scans.length ? scans.map((s) => `<button class="mi" data-ib-s="${s.id}">📱 ${esc(s.label ?? 'Scan')}<small>${s.room ? `Rescan of ${esc(s.room.label)}` : 'New room'} · ${when(s.createdAt)}</small></button>`).join('') : '<div class="empty">No scans waiting.</div>'}`;
  el.querySelectorAll('[data-ib-p]').forEach((b) => (b.onclick = () => { closePops(); goToProposal(Number(b.dataset.ibP)); }));
  el.querySelectorAll('[data-ib-s]').forEach((b) => (b.onclick = () => { closePops(); reviewScan(Number(b.dataset.ibS)); }));
}
function fillMe(el) {
  el.innerHTML = `<div class="hd">${state.editable ? 'Signed in as Michael' : `Read-only (agent key, ${esc(state.me?.scope ?? '')} scope)`}</div>
    <div class="empty small">${state.editable ? 'Every edit is saved as a revision.' : 'You can look and compare; only Michael can change things.'}</div>
    ${state.editable ? '<button class="mi" data-me="pair">📱 Pair phone…<small>Scan a room or capture a piece</small></button>' : ''}
    <button class="mi" data-me="export">Export house JSON</button>
    ${state.me?.kind === 'user' ? '<div class="sep"></div><button class="mi" data-me="out">Sign out</button>' : ''}`;
  el.querySelector('[data-me="pair"]')?.addEventListener('click', () => { closePops(); showPairDialog(); });
  el.querySelector('[data-me="export"]').onclick = async () => { closePops(); try { download('house', await api.exportHouse()); } catch (e) { toast(errMsg(e), true); } };
  el.querySelector('[data-me="out"]')?.addEventListener('click', async () => { try { await api.logout(); } catch { /* signed out anyway */ } location.href = '/login'; });
}
/** Open a proposal's design (or Current) with the proposal shown on the plan. */
async function goToProposal(id) {
  const p = state.proposals.find((x) => x.id === id); if (!p) return;
  const key = p.target.kind === 'current' ? 'cur' : `ws:${p.target.kind === 'workspace' ? p.target.workspace?.id : p.target.copyFrom?.id}`;
  state.panel = 'proposals';
  if (key !== state.open) await openKey(key);
  if (p.status === 'pending' && p.kind !== 'measurements') await showOnPlan(id); else { renderInsp(); openInsp(); }
}

// ---------------------------------------------------------------------------
// Sidebar: Current house (locked) and designs grouped by room
// ---------------------------------------------------------------------------
function originText(w) {
  const o = w.origin ?? {};
  const from = o.kind === 'scan' ? `from scan #${o.scanId}` : o.kind === 'copy' ? `copy of ${o.name}` : o.kind === 'proposal' ? `from proposal #${o.proposalId}`
    : o.kind === 'current' ? `from Current rev ${o.revision}` : 'blank';
  return `${from} · edited ${ago(w.updatedAt ?? w.createdAt)}`;
}
function renderSide() {
  const side = $('side');
  const promoted = (roomId) => state.scans.filter((s) => s.status === 'promoted' && s.room?.id === roomId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  let html = `<h2>🔒 Current house</h2>`;
  if (hasCurrent()) {
    html += currentRooms().map((r) => {
      const sc = promoted(r.id);
      return `<div class="item ${state.open === 'cur' ? 'on' : ''}" data-open="cur" title="The house as it is now (locked)"><span class="ic">▣</span><div class="t"><div class="nm">${esc(r.label)}</div>
        <div class="sub">rev ${state.house.current.revision}${sc ? ` · scanned ${day(sc.createdAt)}` : ''} · ${r.furniture.length} piece${r.furniture.length === 1 ? '' : 's'}</div></div></div>`;
    }).join('');
  } else html += `<div class="empty-state"><strong>No Current yet.</strong> Scan a room with the iPhone app and promote the scan to make one.</div>`;
  if (state.editable) html += `<button class="addlink" data-side="scan">+ Scan a room</button>`;
  for (const s of state.scans.filter((x) => x.status === 'pending'))
    html += `<div class="item scan" data-scan="${s.id}" title="Waiting for your review"><span class="ic">📱</span><div class="t"><div class="nm">${esc(s.label ?? 'Scan')}</div><div class="sub">${s.room ? `Rescan of ${esc(s.room.label)}` : 'New room'} · waiting for review</div></div></div>`;

  const live = liveDesigns(), arch = state.workspaces.filter((w) => w.archived);
  html += `<h2>Designs <span class="grow"></span><span class="badge gray">${live.length}</span></h2>`;
  const groups = new Map();
  for (const w of live) { const g = roomLabelOf(w); groups.set(g, [...(groups.get(g) ?? []), w]); }
  const item = (w) => `<div class="item ${state.open === `ws:${w.id}` ? 'on' : ''}" data-open="ws:${w.id}"><span class="ic">◧</span><div class="t"><div class="nm" title="${esc(w.name)}">${esc(w.name)}</div><div class="sub">${esc(originText(w))}</div></div>
      ${w.pendingProposals ? `<span class="badge" title="${w.pendingProposals} pending proposal(s)">${w.pendingProposals}</span>` : ''}
      <div class="pop-wrap"><button class="dots" data-dots="${w.id}" aria-label="More for ${esc(w.name)}" title="Rename, duplicate, export, archive">⋯</button></div></div>`;
  for (const [g, ws] of groups) html += `<div class="group">${esc(g)}</div>${ws.map(item).join('')}`;
  if (!live.length) html += `<div class="muted small" style="padding:4px 8px">No designs yet.</div>`;
  if (state.editable) html += `<button class="addlink" data-side="new">+ New design</button>`;
  if (arch.length) {
    html += `<button class="archived-toggle" data-side="arch" aria-expanded="${state.archivedOpen}">${state.archivedOpen ? '▾' : '▸'} Archived (${arch.length})${state.archivedOpen ? '' : ` · ${esc(arch.map((w) => w.name).join(', '))}`}</button>`;
    if (state.archivedOpen) html += arch.map(item).join('');
  }
  side.innerHTML = html;
  side.querySelectorAll('[data-open]').forEach((el) => (el.onclick = (e) => { if (e.target.closest('.pop-wrap')) return; openKey(el.dataset.open); }));
  side.querySelectorAll('[data-scan]').forEach((el) => (el.onclick = () => reviewScan(Number(el.dataset.scan))));
  side.querySelector('[data-side="scan"]')?.addEventListener('click', () => showPairDialog());
  side.querySelector('[data-side="new"]')?.addEventListener('click', () => openNewDesign());
  side.querySelector('[data-side="arch"]')?.addEventListener('click', () => { state.archivedOpen = !state.archivedOpen; renderSide(); });
  side.querySelectorAll('[data-dots]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); designMenu(b, Number(b.dataset.dots)); }));
}
/** The ⋯ menu of a design (sidebar and toolbar). */
function designMenu(anchor, id) {
  const w = wsRow(id); if (!w) return;
  closePops();
  const pop = document.createElement('div'); pop.className = 'pop right tool-pop';
  const ed = state.editable;
  pop.innerHTML = `${ed && !w.archived ? '<button class="mi" data-m="rename">Rename</button>' : ''}
    ${ed ? '<button class="mi" data-m="dup">Duplicate…</button>' : ''}
    <button class="mi" data-m="export">Export JSON</button>
    ${ed ? `<div class="sep"></div>${w.archived ? '<button class="mi" data-m="restore">Restore</button>' : w.pendingProposals ? `<button class="mi" disabled>Archive<small>Decide its ${w.pendingProposals} pending proposal(s) first</small></button>` : '<button class="mi danger" data-m="archive">Archive<small>Hidden and read-only; nothing is deleted</small></button>'}` : ''}`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, innerHeight - 220)}px`; pop.style.left = `${Math.max(8, Math.min(r.right - 240, innerWidth - 250))}px`; pop.style.right = 'auto';
  pop.onclick = (e) => e.stopPropagation();
  const act = async (m) => {
    closePops();
    if (m === 'rename') { if (state.open !== `ws:${id}`) await openKey(`ws:${id}`); startRename(id); }
    else if (m === 'dup') openNewDesign({ mode: 'copy', copyFrom: id });
    else if (m === 'export') { try { download(w.name, await loadWs(id, true)); } catch (e) { toast(errMsg(e), true); } }
    else if (m === 'archive') archiveWs(id, true);
    else if (m === 'restore') archiveWs(id, false);
  };
  pop.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => act(b.dataset.m)));
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
}
async function archiveWs(id, archived) {
  const name = wsName(id);
  try {
    await api.archive(id, archived);
    await refreshList();
    if (archived && state.open === `ws:${id}`) { state.compare = null; state.showing = null; state.open = fallbackKey(); }
    if (state.compare === `ws:${id}` && archived) state.compare = null;
    state.cache.delete(id);
    await render();
    if (archived) toast(`Archived “${name}”`, false, () => archiveWs(id, false));
    else { toast(`Restored “${name}”`); }
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function renderTool() {
  const tool = $('tool'), key = state.open;
  if (!key) { tool.innerHTML = state.editable ? '<button class="b" data-t="new">＋ New design</button>' : ''; tool.querySelector('[data-t="new"]')?.addEventListener('click', () => openNewDesign()); return; }
  const undo = `<button class="b edit-only" id="btnUndo" title="Undo" aria-label="Undo" disabled>↶ <span class="lbl-t">Undo</span> <kbd>${MAC ? '⌘Z' : 'Ctrl+Z'}</kbd></button><button class="b edit-only" id="btnRedo" title="Redo" aria-label="Redo" disabled>↷ <span class="lbl-t">Redo</span></button><div class="vsep edit-only"></div>`;
  const cmpOn = !!state.compare && keySc(state.compare) == null;
  const common = `<div class="pop-wrap"><button class="b ${cmpOn ? 'on' : ''}" data-t="compare" aria-haspopup="true">⇆ <span class="lbl-t">Compare</span> ▾</button></div>
    <button class="b ${state.panel === 'history' ? 'on' : ''}" data-t="history">🕘 <span class="lbl-t">History</span></button>`;
  if (key === 'cur') {
    tool.innerHTML = `${undo}<button class="b edit-only" data-t="edit">✎ <span class="lbl-t">Edit in a new design</span></button><button class="b edit-only" data-t="rescan">📱 <span class="lbl-t">Rescan room</span></button><div class="vsep edit-only"></div>
      ${common}<button class="b" data-t="more" aria-label="More">⋯</button><span class="grow"></span><span class="tstatus">Locked: changes only by scans, measurements and approvals</span>`;
  } else {
    const id = keyWs(key), w = wsRow(id), can = canEditWs(id);
    const sv = state.saved.get(key);
    const status = w?.archived ? 'Archived · read-only' : sv ? `Saved · rev ${sv.revision} · ${clock(sv.at)}` : w ? `rev ${w.revision} · edited ${ago(w.updatedAt)}` : '';
    tool.innerHTML = `${can ? undo : ''}${can ? `<div class="pop-wrap"><button class="b" data-t="add" aria-haspopup="true">＋ <span class="lbl-t">Add furniture</span> ▾</button></div><div class="vsep"></div>` : ''}
      ${common}<button class="b" data-t="more" aria-label="More">⋯</button><span class="grow"></span><span class="tstatus" id="saveStatus">${esc(status)}</span>
      ${can && w?.roomIds?.length && hasCurrent() ? '<button class="b primary" data-t="save">⤒ <span class="lbl-t">Save to Current…</span></button>' : ''}`;
  }
  tool.querySelector('[data-t="compare"]').onclick = (e) => { e.stopPropagation(); toolPop(e.currentTarget, fillCompare); };
  tool.querySelector('[data-t="history"]').onclick = () => { setPanel(state.panel === 'history' ? 'details' : 'history'); };
  tool.querySelector('[data-t="more"]').onclick = (e) => {
    e.stopPropagation();
    if (key === 'cur') toolPop(e.currentTarget, (el) => { el.innerHTML = `<button class="mi" data-x="export">Export JSON</button>${state.editable ? '<button class="mi" data-x="pair">📱 Pair phone…</button>' : ''}`; el.querySelector('[data-x="export"]').onclick = () => { closePops(); download('current', currentData()); }; el.querySelector('[data-x="pair"]')?.addEventListener('click', () => { closePops(); showPairDialog(); }); });
    else designMenu(e.currentTarget, keyWs(key));
  };
  tool.querySelector('[data-t="add"]')?.addEventListener('click', (e) => { e.stopPropagation(); toolPop(e.currentTarget, fillAdd, 320); });
  tool.querySelector('[data-t="save"]')?.addEventListener('click', () => openSaveDialog(keyWs(key)));
  tool.querySelector('[data-t="edit"]')?.addEventListener('click', () => openNewDesign({ mode: 'current' }));
  tool.querySelector('[data-t="rescan"]')?.addEventListener('click', () => showPairDialog(currentRooms()[0]?.id));
  $('btnUndo')?.addEventListener('click', () => undoStep('undo'));
  $('btnRedo')?.addEventListener('click', () => undoStep('redo'));
  renderUndo();
}
/** A popover under a toolbar button (the toolbar scrolls, so it is placed on the page). */
function toolPop(anchor, fill, width = 280) {
  const was = document.querySelector(`.tool-pop[data-for="${anchor.dataset.t}"]`);
  closePops();
  if (was) return;
  const pop = document.createElement('div'); pop.className = 'pop tool-pop'; pop.dataset.for = anchor.dataset.t; pop.style.width = `${width}px`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 4}px`; pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  pop.onclick = (e) => e.stopPropagation();
  fill(pop);
  setTimeout(() => document.addEventListener('click', function off(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', off); } }), 0);
}
function fillCompare(el) {
  const open = state.open;
  const others = liveDesigns().filter((w) => `ws:${w.id}` !== open);
  const props = state.proposals.filter((p) => p.status === 'pending' && p.kind !== 'measurements' && proposalIsFor(p, open));
  el.innerHTML = `${open !== 'cur' ? `<button class="mi ${state.compare === 'cur' ? 'on' : ''}" data-c="cur" ${hasCurrent() ? '' : 'disabled'}>🔒 With Current<small>${hasCurrent() ? `The house as it is now (rev ${state.house.current.revision})` : 'No Current yet'}</small></button>` : ''}
    <div class="hd">With another design</div>${others.length ? others.map((w) => `<button class="mi ${state.compare === `ws:${w.id}` ? 'on' : ''}" data-c="ws:${w.id}">◧ ${esc(w.name)}<small>${esc(roomLabelOf(w))}</small></button>`).join('') : '<div class="empty">No other designs.</div>'}
    <div class="hd">With a proposal</div>${props.length ? props.map((p) => `<button class="mi ${state.compare === `pv:${p.id}` ? 'on' : ''}" data-c="pv:${p.id}">#${p.id} ${esc(p.title)}<small>pending · by ${esc(p.agent ?? p.createdBy)}</small></button>`).join('') : '<div class="empty">No pending proposals here.</div>'}
    ${state.compare ? '<div class="sep"></div><button class="mi" data-c="">✕ Close compare</button>' : ''}`;
  el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { closePops(); const k = b.dataset.c; if (keyPv(k) != null) compareProposal(keyPv(k)); else setCompare(k || null); }));
}
let addTab = 'templates';
function fillAdd(el) {
  const tabs = `<div class="ptabs"><button data-at="templates" class="${addTab === 'templates' ? 'on' : ''}">Templates</button><button data-at="catalog" class="${addTab === 'catalog' ? 'on' : ''}">Catalog</button><button data-at="custom" class="${addTab === 'custom' ? 'on' : ''}">Custom box</button></div>`;
  let body = '';
  if (addTab === 'templates') body = state.templates.length ? `<div class="grid2">${state.templates.map((t) => `<button class="mi" data-tpl="${esc(t.slug)}">${esc(t.name)}<small>${t.defaults.wIn}" × ${t.defaults.dIn}"${t.kind === 'rug' ? '' : ` × ${t.defaults.hIn}"`}</small></button>`).join('')}</div>` : '<div class="empty">No templates.</div>';
  else if (addTab === 'catalog') body = `<div class="grid2">${CATALOG.map((c, i) => `<button class="mi" data-cat="${i}">${esc(c.name)}<small>${c.w}" × ${c.d}"${c.kind === 'rug' ? '' : ` × ${c.h}"`}${c.price ? ' · $' + c.price : ''}</small></button>`).join('')}</div>`;
  else body = `<form id="customForm" style="padding:4px 4px 2px"><label>Name <input id="cName" value="Bookshelf" required maxlength="160"></label>
      <div class="row" style="margin-top:6px"><label>W" <input id="cW" type="number" min="1" step="1" value="36" required></label><label>D" <input id="cD" type="number" min="1" step="1" value="14" required></label><label>H" <input id="cH" type="number" min="1" step="1" value="72" required></label></div>
      <div class="row"><label>Color <input id="cColor" type="color" value="#6b4429"></label><button type="submit" class="b primary">Add box</button></div></form>`;
  el.innerHTML = tabs + body;
  el.querySelectorAll('[data-at]').forEach((b) => (b.onclick = () => { addTab = b.dataset.at; fillAdd(el); }));
  el.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => { closePops(); addTemplatePiece(state.templates.find((t) => t.slug === b.dataset.tpl)); }));
  el.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { closePops(); addPiece(CATALOG[Number(b.dataset.cat)]); }));
  el.querySelector('#customForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => el.querySelector(`#${id}`).value;
    const spec = { kind: 'box', name: v('cName').trim() || 'Custom box', w: +v('cW'), d: +v('cD'), h: +v('cH'), color: v('cColor') };
    if (spec.w > 0 && spec.d > 0 && spec.h > 0) { closePops(); addPiece(spec); }
  });
}

// ---------------------------------------------------------------------------
// Editing (every edit = a revision; Michael's own edits count as approved)
// ---------------------------------------------------------------------------
function setStatus(t) { const el = $('saveStatus'); if (el) el.textContent = t; }
async function saveOps(wsId, changes, note, local) {
  const ws = await loadWs(wsId);
  setStatus('Saving…');
  try {
    const r = await api.save(wsId, ws.revision, changes, note);
    if (!r.unchanged) state.saved.set(`ws:${wsId}`, { revision: r.revision, at: new Date() });
    clearDraft(wsId);
    if (!r.unchanged) recordUndo(`ws:${wsId}`, { kind: 'rev', wsId, revision: r.revision, label: note });
    await rerenderWs(wsId);
    if (r.unchanged) setStatus('No change.');
    return r;
  } catch (e) {
    if (e instanceof ApiError) {
      setStatus('Not saved.');
      toast(e.status === 409 && e.body?.error === 'conflict' ? 'This design changed on another device. Reloaded the latest.' : `Not saved: ${errMsg(e)}`, true);
      await rerenderWs(wsId);
    } else {
      const draft = keepDraft(wsId, ws.revision, changes, note, local);
      recordUndo(`ws:${wsId}`, { kind: 'draft', wsId, draft, label: note });
      setStatus('Offline: kept as a draft on this device; it will be saved when you reconnect.');
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
/** The design new pieces go into: the focused pane if it is an editable design, else the open design. */
function targetWs() {
  const f = focusedWs();
  if (canEditWs(f)) return f;
  const o = keyWs(state.open);
  return canEditWs(o) ? o : null;
}
function roomCenter(data) {
  const room = data.rooms[0];
  const xs = room.walls.flatMap((w) => [w.startXIn, w.endXIn]), ys = room.walls.flatMap((w) => [w.startYIn, w.endYIn]);
  return { room, cx: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), cy: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
}
function addPiece(spec) {
  const wsId = targetWs(); const data = wsId != null && state.cache.get(wsId);
  if (!data || !data.rooms.length) return toast('Open a design with a room first', true);
  const { room, cx, cy } = roomCenter(data);
  saveOps(wsId, [
    { op: 'create', entityType: 'furniture_item', tempRef: 'i', fields: { kind: spec.kind, name: spec.name, wIn: Math.round(spec.w), dIn: Math.round(spec.d), hIn: Math.max(1, Math.round(spec.h)), color: spec.color, accentColor: spec.accent ?? null, status: 'idea', url: spec.url || null, priceCents: spec.price ? Math.round(spec.price * 100) : null } },
    { op: 'create', entityType: 'placement', tempRef: 'p', fields: { roomId: room.id, itemId: '$i', xIn: cx, yIn: cy, rotationDeg: 0, action: 'new' } },
  ], `Added ${spec.name}`);
}
function addTemplatePiece(t) {
  const wsId = targetWs(); const data = wsId != null && state.cache.get(wsId);
  if (!t || !data || !data.rooms.length) return toast('Open a design with a room first', true);
  const { room, cx, cy } = roomCenter(data);
  saveOps(wsId, [
    { op: 'create', entityType: 'furniture_item', tempRef: 'i', fields: { kind: t.kind, name: t.name, wIn: t.defaults.wIn, dIn: t.defaults.dIn, hIn: Math.max(1, t.defaults.hIn), status: 'idea' } },
    { op: 'create', entityType: 'placement', tempRef: 'p', fields: { roomId: room.id, itemId: '$i', xIn: cx, yIn: cy, rotationDeg: 0, action: 'new', templateId: t.id } },
  ], `Added ${t.name}`);
}
function duplicateSelected() {
  const p = state.selection, wsId = focusedWs();
  if (!p || !canEditWs(wsId)) return;
  const it = p.item;
  const item = { kind: it.kind, name: it.name, wIn: it.wIn, dIn: it.dIn, hIn: it.hIn, status: 'idea' };
  for (const k of ['color', 'accentColor', 'url', 'priceCents', 'notes']) if (it[k] != null) item[k] = it[k];
  const pl = { roomId: p.roomId, itemId: '$i', xIn: p.xIn + 12, yIn: p.yIn + 12, rotationDeg: p.rotationDeg, action: 'new' };
  if (p.templateId != null) pl.templateId = p.templateId;
  if (p.modelId != null) pl.modelId = p.modelId;
  const ops = [{ op: 'create', entityType: 'furniture_item', tempRef: 'i', fields: item }, { op: 'create', entityType: 'placement', tempRef: 'p', fields: pl }];
  for (const [key, value] of Object.entries(p.template?.params ?? {})) ops.push({ op: 'create', entityType: 'placement_param', fields: { placementId: '$p', key, value } });
  saveOps(wsId, ops, `Duplicated ${it.name}`);
}
function deleteSelected() {
  const p = state.selection, wsId = focusedWs();
  if (!p || !canEditWs(wsId)) return;
  if (!confirm(`Delete “${p.item.name}” from this design? (Undo with ${MAC ? '⌘Z' : 'Ctrl+Z'}, or roll it back from History.)`)) return;
  saveOps(wsId, [{ op: 'delete', entityType: 'placement', entityId: p.id }], `Removed ${p.item.name}`);
}
const fv = () => focusedPane()?.view;

// ---------------------------------------------------------------------------
// Inspector: Details / Proposals / History
// ---------------------------------------------------------------------------
function setPanel(tab) {
  state.panel = tab; renderInsp(); renderTool(); writeUrl(); openInsp();
  if (state.inspHidden) { state.inspHidden = false; document.body.classList.remove('noinsp'); }
}
let selTimer;
function renderSelectionLater() { clearTimeout(selTimer); selTimer = setTimeout(() => { if (state.panel === 'details') renderInsp(); placeFloatbar(true); }, 30); }
function renderInsp() {
  const key = state.open;
  document.querySelectorAll('.itabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.panel));
  const n = key ? pendingFor(key).length : 0;
  $('propN').hidden = !n; $('propN').textContent = n;
  const body = $('inspBody');
  if (!key) { body.innerHTML = '<p class="muted">Nothing open.</p>'; return; }
  if (state.panel === 'proposals') renderProposals(body);
  else if (state.panel === 'history') renderHistory(body);
  else renderDetails(body);
}
function renderDetails(body) {
  const pane = focusedPane(), key = pane?.key, data = pane?.data;
  let html = '';
  const scId = keySc(state.compare);
  if (scId != null) html += scanReviewHtml(scId);
  const pend = state.open ? pendingFor(state.open) : [];
  if (pend.length) html += `<div class="card prop banner-card" data-go="proposals"><span class="pill">${pend.length} pending</span> ${esc(pend[0].title)}${pend.length > 1 ? ` and ${pend.length - 1} more` : ''} · <b style="color:#7a5a3a">Review ›</b></div>`;
  if (!data) { body.innerHTML = html; wireDetails(body); return; }
  const p = state.selection;
  const editable = !!pane.info?.editable;
  if (p && !p._removed) {
    const f = footprintFt(p);
    html += `<h3>Selected</h3><div class="card"><h4>${esc(p.item.name)}</h4>
      <div class="meta">${fmtIn(p.item.wIn)} W × ${fmtIn(p.item.dIn)} D × ${fmtIn(p.item.hIn)} H · ${esc(p.action)}${p.item.status ? ' · ' + esc(p.item.status) : ''}</div>
      <div class="meta">At x ${fmtIn(p.xIn)}, y ${fmtIn(p.yIn)} · rotated ${p.rotationDeg}° · footprint ${fmtIn(Math.round(f.w * 12))} × ${fmtIn(Math.round(f.d * 12))}</div>
      ${editable ? `<div class="actions"><button class="b" data-sel="rotate">⟳ Rotate <kbd>R</kbd></button><button class="b" data-sel="dup">⧉ Duplicate</button><button class="b danger" data-sel="delete">Delete</button></div>` : ''}</div>
      ${templatePanelHtml(p, editable)}
      ${editable ? `<label class="prm"><span>In this design</span><select id="actionSel">${['existing', 'keep', 'replace', 'remove', 'new'].map((a) => `<option value="${a}" ${p.action === a ? 'selected' : ''}>${{ existing: 'existing (as is)', keep: 'keep', replace: 'replace', remove: 'remove', new: 'new' }[a]}</option>`).join('')}</select></label>` : ''}
      <h3>Measurements (in)</h3>${measRow('furniture_item', p.item.id, 'wIn', 'Width', p.item.wIn, p.item.measurements)}${measRow('furniture_item', p.item.id, 'dIn', 'Depth', p.item.dIn, p.item.measurements)}${measRow('furniture_item', p.item.id, 'hIn', 'Height', p.item.hIn, p.item.measurements)}
      ${modelHtml(p, editable)}`;
  } else {
    html += roomDetailsHtml(data, key, editable);
    if (editable) html += '<p class="meta">Tap a piece to select it. Drag to move it.</p>';
  }
  body.innerHTML = html;
  wireDetails(body, p, editable);
  if (!p) loadPhotos(data);
}
function wireDetails(body, p, editable) {
  body.querySelector('[data-go="proposals"]')?.addEventListener('click', () => setPanel('proposals'));
  wireScanReview(body);
  if (!p) { wireRoom(body); wireMeasurements(body); return; }
  body.querySelector('[data-sel="rotate"]')?.addEventListener('click', () => fv()?.rotateSelected());
  body.querySelector('[data-sel="dup"]')?.addEventListener('click', duplicateSelected);
  body.querySelector('[data-sel="delete"]')?.addEventListener('click', deleteSelected);
  const wsId = focusedWs();
  body.querySelector('#actionSel')?.addEventListener('change', (e) => saveOps(wsId, [{ op: 'update', entityType: 'placement', entityId: p.id, field: 'action', value: e.target.value }], `Marked ${p.item.name} ${e.target.value}`));
  wireMeasurements(body);
  if (!editable) return;
  body.querySelector('#tplSel')?.addEventListener('change', (e) => setTemplate(wsId, p, e.target.value));
  body.querySelectorAll('[data-k]').forEach((inp) => (inp.onchange = () => setParam(wsId, p, inp.dataset.k, inp.type === 'checkbox' ? String(inp.checked) : inp.value)));
  body.querySelector('#btnCapture')?.addEventListener('click', () => showCaptureDialog(p));
  body.querySelector('#btnModelFile')?.addEventListener('click', () => body.querySelector('#modelFile').click());
  body.querySelector('#modelFile')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!/\.(usdz|glb)$/i.test(f.name)) return toast('Choose a .usdz or .glb file', true);
    try { setStatus('Uploading model…'); await api.uploadModel(f, { label: f.name.replace(/\.[^.]+$/, ''), placementId: p.id }); toast('Model attached'); await rerenderWs(wsId); }
    catch (err) { toast(`Upload failed: ${errMsg(err)}`, true); }
  });
  body.querySelector('#btnModelOff')?.addEventListener('click', async () => { try { await api.setModel(p.id, null); toast('Model removed; the template is drawn again'); await rerenderWs(wsId); } catch (err) { toast(errMsg(err), true); } });
}
function templatePanelHtml(p, editable) {
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
  return `<label class="prm"><span>Template</span><select id="tplSel" ${dis}><option value="">(basic shape)</option>${state.templates.map((x) => `<option value="${esc(x.slug)}" ${x.slug === p.template?.slug ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    ${t ? t.params.map((q) => `<label class="prm"><span>${esc(q.label)}</span>${input(q)}</label>`).join('') : ''}`;
}
function modelHtml(p, editable) {
  const m = p.model;
  return `<h3>3D model</h3><div class="model">${m ? `<b>${esc(m.label)}</b> <span class="muted">(${esc(m.format)}, ${m.source === 'object_capture' ? 'captured on iPhone' : 'uploaded'}, ${Math.round((m.bytes ?? 0) / 1024)} KB)</span><div class="meta">The model is drawn instead of the template.</div>` : '<div class="meta">No model yet. The template is drawn.</div>'}
    ${editable ? `<div class="actions"><button class="b" id="btnCapture" title="Pair the iPhone app to capture this piece with Object Capture">📱 Capture this piece</button><button class="b" id="btnModelFile">Upload…</button>${m ? '<button class="b danger" id="btnModelOff">Remove</button>' : ''}</div><input type="file" id="modelFile" accept=".usdz,.glb,model/vnd.usdz+zip,model/gltf-binary" hidden>` : ''}</div>`;
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
    <div class="actions" style="justify-content:flex-end"><button class="b" data-close>Done</button></div>`);
}

// Room details: colors, photos, measurements, mirror fix
function roomDetailsHtml(data, key, editable) {
  const rooms = data?.rooms ?? [];
  if (!rooms.length) return '<p class="muted">No rooms here.</p>';
  const wsId = keyWs(key);
  const sw = (c) => (c?.color ? `<span class="sw" style="background:${esc(c.color)}"></span>${esc(c.name ?? c.color)}` : c?.name ? esc(c.name) : '—');
  const hex = (c) => (/^#[0-9a-f]{6}/i.test(c ?? '') ? c.slice(0, 7) : '#ffffff');
  let html = '';
  for (const r of rooms) {
    html += `<h3>${esc(r.label)} · colors</h3>`;
    const rows = [['wall', 'Walls', r.wallColor], ['trim', 'Trim', r.trimColor], ['floor', 'Floor', { color: r.floor?.color, name: r.floor?.colorName }], ['device', 'Outlets', r.deviceColor]];
    if (editable && wsId != null) html += `<div class="colors" data-room="${r.id}">${rows.map(([k, l, c]) => `<span>${l}</span><span>${c?.name ? `<span class="meta">${esc(c.name)}</span> ` : ''}<input type="color" data-color="${k}" value="${esc(hex(c?.color))}" title="${l} color (undo with ${MAC ? '⌘Z' : 'Ctrl+Z'})" aria-label="${l} color"></span>`).join('')}</div>`;
    else html += `<div class="kv">${rows.map(([, l, c]) => `<span>${l}</span><span>${sw(c)}</span>`).join('')}</div>`;
    if (r.mirrored) html += `<div class="mirror-note">This room came from an older scan and is drawn as a <b>mirror image</b>. ${state.editable ? `<button class="b sm" data-mirror="${r.id}">Fix mirror image</button>` : 'Michael can fix it.'}</div>`;
  }
  html += `<h3>Photos</h3><div id="photoStrip" class="photo-strip"><span class="meta">Loading…</span></div>`;
  html += `<h3>Measurements (in)</h3>`;
  for (const r of rooms) {
    html += `<div class="meta"><b>${esc(r.label)}</b></div>`;
    html += measRow('room', r.id, 'ceilingIn', 'Ceiling', r.ceilingIn, r.measurements);
    for (const w of r.walls.filter((w) => !w.isOpen)) {
      html += measRow('wall', w.id, 'heightIn', `${w.label ?? 'Wall'} height`, w.heightIn, w.measurements);
      for (const o of w.openings) html += measRow('opening', o.id, 'widthIn', `${o.label ?? o.type} width`, o.widthIn, o.measurements);
    }
  }
  return html;
}
function wireRoom(body) {
  const pane = focusedPane(), wsId = keyWs(pane?.key), rooms = pane?.data?.rooms ?? [];
  body.querySelectorAll('.colors input[data-color]').forEach((inp) => (inp.onchange = () => {
    const room = rooms.find((r) => r.id === Number(inp.closest('.colors').dataset.room));
    setColor(wsId, room, inp.dataset.color, inp.value);
  }));
  body.querySelectorAll('button[data-mirror]').forEach((b) => (b.onclick = () => fixMirror(Number(b.dataset.mirror))));
}
let photoReq = 0;
async function loadPhotos(data) {
  const n = ++photoReq, rooms = data?.rooms ?? [];
  let photos = [];
  try { photos = (await Promise.all(rooms.filter((r) => typeof r.id === 'number').map((r) => api.photos({ roomId: r.id })))).flat(); } catch { /* reader without photos */ }
  if (n !== photoReq) return;
  const el = $('photoStrip'); if (!el) return;
  el.innerHTML = photos.length ? photos.map(photoThumb).join('') : '<span class="meta">No photos for this room yet.</span>';
  const h = el.previousElementSibling; if (h && photos.length) h.textContent = `Photos (${photos.length})`;
}
function setColor(wsId, room, k, value) {
  const label = { wall: 'walls', trim: 'trim', floor: 'floor', device: 'outlets/switches' }[k];
  const st = room.style;
  const changes = st
    ? [{ op: 'update', entityType: 'room_style', entityId: st.id, field: `${k}Color`, value }, ...(st[`${k}ColorName`] ? [{ op: 'update', entityType: 'room_style', entityId: st.id, field: `${k}ColorName`, value: null }] : [])]
    : [{ op: 'create', entityType: 'room_style', fields: { roomId: room.id, [`${k}Color`]: value } }];
  saveOps(wsId, changes, `${room.label}: ${label} color ${value}`);
}
const photoThumb = (ph) => `<a href="${esc(ph.url)}" target="_blank" rel="noopener" title="${esc([ph.prompt, ph.note, (ph.tags ?? []).join(', ')].filter(Boolean).join(' · '))}"><img src="${esc(ph.url)}" alt="${esc(ph.prompt ?? 'Room photo')}" loading="lazy"></a>`;
async function fixMirror(roomId) {
  if (!confirm('Flip this room back to the right way round?\n\nOlder scans were parsed as a mirror image. This flips its walls (one Current revision you can roll back).')) return;
  try { const r = await api.fixMirror(roomId); toast(`Fixed. Current revision ${r.revision}.`); await refreshHouse(); await render(); }
  catch (e) { toast(errMsg(e), true); }
}

// Measurements (with their source: scan, measured, pinned, estimate)
function measRow(entityType, entityId, field, label, value, m) {
  const src = m?.[field];
  const pinned = !!src?.pinned;
  const key = focusedKey();
  const can = state.editable && (canEditWs(keyWs(key)) || key === 'cur');
  return `<div class="meas" data-et="${entityType}" data-id="${entityId}" data-field="${field}">
    <span>${esc(label)}<span class="src ${src?.source ?? 'manual_estimate'}">${pinned ? 'pinned' : esc((src?.source ?? 'estimate').replace('manual_estimate', 'estimate'))}</span></span>
    <input type="number" step="1" min="0" value="${value ?? ''}" ${can && !pinned ? '' : 'disabled'} aria-label="${esc(label)} in inches">
    ${can ? (pinned ? `<button data-act="unpin" title="Release the pin">Unpin</button><span></span>` : `<button data-act="measured" title="Save as a tape measurement">Measured</button><button data-act="pin" title="Pin: scans and estimates can never overwrite it">Pin</button>`) : '<span></span><span></span>'}
  </div>`;
}
function wireMeasurements(body) { body.querySelectorAll('.meas button[data-act]').forEach((b) => (b.onclick = () => measure(b))); }
async function measure(btn) {
  const row = btn.closest('.meas'), key = focusedKey(), wsId = keyWs(key);
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
    if (key === 'cur') { await refreshHouse(); renderInsp(); renderSide(); }
    else await rerenderWs(wsId);
    if (sel) focusedPane()?.view.select(sel);
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Proposals: in context, with Show on plan / Compare, Approve (with Undo) / Reject (with a reason)
// ---------------------------------------------------------------------------
function diffRow(c) {
  if (c.op === 'measure') return `<tr><td>${esc(c.entityType)} ${esc(c.label ?? '')} <span class="meta">#${c.entityId}</span><br><span class="meta">${esc(c.field)}${c.note ? ` · ${esc(c.note)}` : ''}</span></td><td><span class="before">${esc(fmtVal(c.field, c.before))}</span> → <span class="after">${esc(fmtVal(c.field, c.after))}</span></td></tr>`;
  const what = `${esc(c.entityType.replace('_', ' '))} ${esc(c.label ?? '')}${c.entityId ? ` <span class="meta">#${c.entityId}</span>` : ''}`;
  if (c.op === 'update') return `<tr><td>${what}<br><span class="meta">${esc(c.field)}</span></td><td><span class="before">${esc(fmtVal(c.field, c.before))}</span> → <span class="after">${esc(fmtVal(c.field, c.after))}</span></td></tr>`;
  if (c.op === 'delete') return `<tr><td>${what}</td><td><span class="before">delete</span></td></tr>`;
  const f = Object.entries(c.fields ?? {}).map(([k, v]) => `${esc(k)}: ${esc(fmtVal(k, v))}`).join(', ');
  return `<tr><td>+ ${esc(c.entityType.replace('_', ' '))} ${esc(c.label ?? '')}</td><td><span class="after">${f}</span></td></tr>`;
}
function targetText(p) {
  return p.target.kind === 'current' ? (p.target.what === 'furnishings' ? 'Current (furniture and colors)' : 'Current (measurements)') : p.target.kind === 'new_workspace'
    ? `New design “${esc(p.target.name)}” (copy of ${esc(p.target.copyFrom?.name ?? '?')})${p.target.createdWorkspace ? ` → made #${p.target.createdWorkspace.id}` : ''}`
    : esc(p.target.workspace?.name ?? 'deleted design');
}
function proposalCard(p, { full = true } = {}) {
  const src = p.source.url ? `<a href="${esc(p.source.url)}" target="_blank" rel="noopener">${esc(p.source.kind.replace('_', ' '))}</a>` : esc(p.source.kind.replace('_', ' '));
  const head = `<div class="meta"><span class="pill ${p.status}">${p.status}</span> #${p.id} · by ${esc(p.agent ?? p.createdBy)} · ${when(p.createdAt)}</div><h4>${esc(p.title)}</h4>`;
  if (!full) return `<div class="card compact" data-pid="${p.id}" title="Show details">${head}${p.decidedAt ? `<div class="meta">Decided ${when(p.decidedAt)}${p.decisionNote ? `: ${esc(p.decisionNote)}` : ''}</div>` : ''}</div>`;
  const steps = p.cost.steps.map((s) => `<tr><td>${esc(s.step)}</td><td>${esc(s.changes)}</td><td class="num">${usd(s.lowUsd)}–${usd(s.highUsd)}</td></tr>`).join('');
  const can = state.editable && p.status === 'pending';
  const viewable = p.status === 'pending' && p.kind !== 'measurements';
  const showingThis = state.showing === p.id, comparingThis = state.compare === `pv:${p.id}`;
  return `<div class="card ${p.status === 'pending' ? 'prop' : ''}" data-pid="${p.id}">${head}
    <div class="meta">For: ${targetText(p)} · Room: ${p.rooms.map((r) => esc(r.label)).join(', ') || '—'} · source: ${src}</div>
    <p style="margin:6px 0">${esc(p.rationale)}</p>
    <details ${p.changes.length <= 6 ? 'open' : ''}><summary class="meta">${p.kind === 'measurements' ? 'Measurements to record' : 'Changes'} (${p.changes.length})</summary><table class="diff">${p.changes.map(diffRow).join('')}</table></details>
    ${p.photos?.length ? `<div class="photo-strip">${p.photos.map(photoThumb).join('')}</div>` : ''}
    <table class="cost"><tr><th>Step</th><th>What changes</th><th class="num">Low–high</th></tr>${steps}<tr><td colspan="2"><b>Total</b></td><td class="num"><b>${usd(p.cost.lowUsd)}–${usd(p.cost.highUsd)}</b></td></tr></table>
    ${p.decidedAt ? `<div class="meta" style="margin-top:6px">Decided ${when(p.decidedAt)}${p.decisionNote ? `: ${esc(p.decisionNote)}` : ''}${p.appliedRevision ? ` · applied as revision ${p.appliedRevision.number}` : ''}</div>` : ''}
    ${viewable ? `<div class="actions"><button class="b ${showingThis ? 'on' : ''}" data-act="show">👁 ${showingThis ? 'Showing on plan' : 'Show on plan'}</button><button class="b ${comparingThis ? 'on' : ''}" data-act="compare">⇆ Compare</button></div>` : ''}
    ${can ? `<div class="actions"><button class="b primary wide" data-act="approve">✓ Approve</button><button class="b danger wide" data-act="reject">✕ Reject</button></div>
      <div class="reject-box" hidden><input class="reject-note" placeholder="Why not? (optional, kept with the proposal)" maxlength="1000"><div class="actions" style="margin-top:0"><button class="b danger" data-act="reject-go">Reject</button><button class="b" data-act="reject-cancel">Cancel</button></div></div>` : ''}
  </div>`;
}
function renderProposals(body) {
  const key = state.open;
  const here = state.proposals.filter((p) => proposalIsFor(p, key) || (key !== 'cur' && p.target.kind === 'new_workspace' && p.target.copyFrom?.id === keyWs(key)));
  const list = state.propScope === 'house' ? state.proposals : here;
  const pending = list.filter((p) => p.status === 'pending'), decided = list.filter((p) => p.status !== 'pending').sort((a, b) => new Date(b.decidedAt ?? b.createdAt) - new Date(a.decidedAt ?? a.createdAt));
  const where = key === 'cur' ? 'Current' : 'this design';
  body.innerHTML = `<div class="row" style="align-items:center"><select id="propScope" aria-label="Which proposals"><option value="here" ${state.propScope === 'here' ? 'selected' : ''}>For ${where}</option><option value="house" ${state.propScope === 'house' ? 'selected' : ''}>Whole house</option></select></div>
    ${state.editable ? '' : '<p class="meta">Only Michael can approve or reject (signed in with a passkey).</p>'}
    <h3>Pending${state.propScope === 'here' ? ` for ${where}` : ''}</h3>${pending.length ? pending.map((p) => proposalCard(p)).join('') : '<p class="meta">Nothing waiting.</p>'}
    <h3>${state.propScope === 'here' ? 'Recently decided' : 'Decided'}</h3>${decided.length ? (state.propScope === 'here' ? decided.slice(0, 8) : decided).map((p) => proposalCard(p, { full: false })).join('') : '<p class="meta">None yet.</p>'}`;
  body.querySelector('#propScope').onchange = (e) => { state.propScope = e.target.value; renderInsp(); };
  body.querySelectorAll('.card.compact').forEach((c) => (c.onclick = () => { const p = state.proposals.find((x) => x.id === Number(c.dataset.pid)); c.outerHTML = proposalCard(p); wireProposalCards(body); }));
  wireProposalCards(body);
}
function wireProposalCards(body) {
  body.querySelectorAll('.card[data-pid] button[data-act]').forEach((b) => (b.onclick = () => proposalAction(Number(b.closest('.card').dataset.pid), b.dataset.act, b)));
}
function openRejectBox(id) {
  const card = $('inspBody').querySelector(`.card[data-pid="${id}"]`); if (!card) return;
  card.querySelector('.reject-box').hidden = false; card.querySelector('.reject-note').focus();
}
async function proposalAction(id, act, btn) {
  const card = btn?.closest('.card');
  if (act === 'show') return state.showing === id ? (state.showing = null, render()) : showOnPlan(id);
  if (act === 'compare') return state.compare === `pv:${id}` ? closeCompare() : compareProposal(id);
  if (act === 'approve') return approve(id);
  if (act === 'reject') { card.querySelector('.reject-box').hidden = false; card.querySelector('.reject-note').focus(); return; }
  if (act === 'reject-cancel') { card.querySelector('.reject-box').hidden = true; return; }
  if (act === 'reject-go') {
    try {
      await api.reject(id, card.querySelector('.reject-note').value.trim() || undefined);
      toast('Rejected. Kept for the record; nothing changed.');
      if (state.showing === id) state.showing = null;
      if (state.compare === `pv:${id}`) state.compare = null;
      state.previews.delete(id);
      await refreshProposals(); await refreshList(); await render();
    } catch (e) { toast(errMsg(e), true); }
  }
}
/** Approve without a confirm: a 5-second "Approved · Undo" toast instead (rollback from History still works). */
async function approve(id) {
  const p = state.proposals.find((x) => x.id === id);
  try {
    const r = await api.approve(id);
    state.previews.delete(id);
    if (state.showing === id) state.showing = null;
    if (state.compare === `pv:${id}`) state.compare = null;
    await refreshProposals(); await refreshList();
    if (r.workspaceId == null) { await refreshHouse(); }
    else {
      state.cache.delete(r.workspaceId);
      if (p?.target.kind === 'new_workspace') state.open = `ws:${r.workspaceId}`;
    }
    await render();
    const msg = p?.kind === 'measurements' ? `Approved. Recorded ${r.measurements?.length ?? 0} measurement(s) in Current.`
      : r.workspaceId == null ? `Approved · Current is at rev ${r.revision}` : p?.target.kind === 'new_workspace' ? `Approved · made “${wsName(r.workspaceId)}”` : `Approved · ${wsName(r.workspaceId)} rev ${r.revision}`;
    toast(msg, false, p?.kind === 'measurements' ? null : () => undoApproval(id));
  } catch (e) { toast(errMsg(e), true); await refreshProposals().catch(() => {}); renderInsp(); }
}
async function undoApproval(id) {
  try {
    const r = await api.undoApprove(id);
    await refreshProposals(); await refreshList(); await refreshHouse();
    if (r.workspaceId != null) state.cache.delete(r.workspaceId);
    if (r.archivedWorkspaceId != null && state.open === `ws:${r.archivedWorkspaceId}`) state.open = fallbackKey();
    await render();
    toast(`Undone. Proposal #${id} is waiting again.`);
  } catch (e) { toast(`Couldn't undo: ${errMsg(e)}`, true); }
}
/** Show a pending proposal on the open plan (its target must be open). */
async function showOnPlan(id) {
  const p = state.proposals.find((x) => x.id === id); if (!p) return;
  const key = p.target.kind === 'current' ? 'cur' : `ws:${p.target.kind === 'workspace' ? p.target.workspace?.id : p.target.copyFrom?.id}`;
  if (key !== state.open) state.open = key;
  if (keyWs(key) != null) await loadWs(keyWs(key));
  state.previews.delete(id);
  try { state.previews.set(id, await api.preview(id)); } catch (e) { return toast(`Preview failed: ${errMsg(e)}`, true); }
  state.showing = id; state.compare = null; state.panel = 'proposals';
  await render();
}
async function compareProposal(id) {
  const p = state.proposals.find((x) => x.id === id); if (!p) return;
  const key = p.target.kind === 'current' ? 'cur' : `ws:${p.target.kind === 'workspace' ? p.target.workspace?.id : p.target.copyFrom?.id}`;
  state.open = key; state.showing = null;
  state.previews.delete(id);
  try { state.previews.set(id, await api.preview(id)); } catch (e) { return toast(`Preview failed: ${errMsg(e)}`, true); }
  state.compare = `pv:${id}`; prefs.sync = true; savePrefs();
  await render();
}

// ---------------------------------------------------------------------------
// History (append-only revisions; Current also lists its scans)
// ---------------------------------------------------------------------------
async function renderHistory(body) {
  const key = state.open, wsId = keyWs(key);
  body.innerHTML = '<p class="meta">Loading…</p>';
  let revs;
  try { revs = key === 'cur' ? await api.currentHistory() : await api.history(wsId); } catch (e) { body.innerHTML = `<p class="meta">${esc(errMsg(e))}</p>`; return; }
  if (state.panel !== 'history' || state.open !== key) return;
  const data = key === 'cur' ? currentData() : state.cache.get(wsId);
  const names = new Map();
  for (const r of data?.rooms ?? []) for (const f of r.furniture) { names.set(`placement:${f.id}`, f.item.name); names.set(`furniture_item:${f.item.id}`, f.item.name); }
  const floor = key === 'cur' ? 1 : Math.max(0, ...revs.filter((r) => r.kind === 'seed' || r.kind === 'copy').map((r) => r.number));
  const latest = revs[0]?.number ?? 0;
  const canRb = key === 'cur' ? state.editable : canEditWs(wsId);
  body.innerHTML = `<p class="meta">${key === 'cur' ? 'Current changes only through promoted scans, measurements and proposals you approve. ' : ''}Append-only: rolling back adds a new revision; nothing is erased. Pinned measurements are kept.</p>` + revs.map((r) => {
    const rows = r.changes.filter((c) => c.field && c.field !== 'measurementStatus').slice(0, 40).map((c) =>
      `<div>${esc(c.op)} ${esc(c.entityType.replace('_', ' '))} ${esc(names.get(`${c.entityType}:${c.entityId}`) ?? '#' + c.entityId)} · ${esc(c.field)}: ${c.op === 'create' ? '' : `<span class="before">${esc(fmtVal(c.field, c.before))}</span> → `}${c.op === 'delete' ? '' : `<span class="after">${esc(fmtVal(c.field, c.after))}</span>`}</div>`).join('');
    return `<div class="rev-row"><div><b>Revision ${r.number}</b> <span class="k">${esc(r.kind)}</span> · ${esc(r.agent ?? r.actor)} · ${when(r.createdAt)}</div>
      <div class="meta">${esc(r.note ?? '')}${r.proposal ? ` (proposal #${r.proposal.id})` : ''}</div>
      ${rows ? `<details><summary>${r.changeCount} change rows</summary>${rows}</details>` : ''}
      ${canRb && r.number < latest && r.number >= floor ? `<div class="actions" style="margin-top:4px"><button class="b sm" data-rb="${r.number}">Roll back to here</button></div>` : ''}</div>`;
  }).join('') + (key === 'cur' ? scansSectionHtml() : '');
  body.querySelectorAll('button[data-rb]').forEach((b) => (b.onclick = async () => {
    const n = Number(b.dataset.rb), label = key === 'cur' ? 'Current' : `“${wsName(wsId)}”`;
    if (!confirm(`Roll ${label} back to revision ${n}?\n\nThis adds a new revision that undoes everything after ${n}. Pinned measurements are kept.`)) return;
    try {
      const r = key === 'cur' ? await api.rollbackCurrent(n) : await api.rollback(wsId, n);
      toast(`Rolled back. Now at revision ${r.revision}${r.skipped?.length ? ` (kept ${r.skipped.length} pinned/used value(s))` : ''}.`);
      if (key === 'cur') { await refreshHouse(); await render(); } else await rerenderWs(wsId);
    } catch (e) { toast(errMsg(e), true); }
  }));
  wireScanButtons(body);
}
function scansSectionHtml() {
  if (!state.scans.length) return '<h3>Scans</h3><p class="meta">No scans yet.</p>';
  return `<h3>Scans</h3>${state.scans.map((s) => `<div class="card"><div class="meta"><span class="pill ${s.status}">${esc(s.status)}</span> #${s.id} · ${when(s.createdAt)} · ${s.files} file(s)</div>
    <b>${esc(s.label ?? 'Scan')}</b><div class="meta">${s.room ? `${s.status === 'pending' ? 'Rescan of' : 'Room:'} ${esc(s.room.label)}` : 'New room'}</div>
    <div class="actions"><button class="b sm" data-scan-open="${s.id}">${s.status === 'pending' ? 'Review' : 'Open'}</button>
    ${s.status === 'promoted' && state.editable ? (s.designId ? `<button class="b sm" data-scan-design="${s.designId}">Open its design</button>` : `<button class="b sm" data-scan-furnish="${s.id}">Start a design from this scan</button>`) : ''}</div></div>`).join('')}`;
}
function wireScanButtons(body) {
  body.querySelectorAll('[data-scan-open]').forEach((b) => (b.onclick = () => reviewScan(Number(b.dataset.scanOpen))));
  body.querySelectorAll('[data-scan-design]').forEach((b) => (b.onclick = () => openKey(`ws:${b.dataset.scanDesign}`, { panel: 'details' })));
  body.querySelectorAll('[data-scan-furnish]').forEach((b) => (b.onclick = () => furnishScan(Number(b.dataset.scanFurnish))));
}

// ---------------------------------------------------------------------------
// Undo / redo (per view). Saved edits are undone by a new revision that reverts them (history is never
// rewritten, and the server refuses if a later edit changed the same values); unsaved offline edits are
// taken off the queue; measurements are withdrawn or restored.
// ---------------------------------------------------------------------------
function recordUndo(key, entry) { if (!key) return; state.undo.of(key).record(entry); renderUndo(); }
function renderUndo() {
  const key = focusedKey(), h = key && (keyWs(key) != null || key === 'cur') ? state.undo.of(key) : null;
  const u = h?.peekUndo(), r = h?.peekRedo();
  const bu = $('btnUndo'), br = $('btnRedo'); if (!bu || !br) return;
  bu.disabled = !u || state.undoBusy; br.disabled = !r || state.undoBusy;
  bu.title = u ? `Undo: ${u.label ?? 'last edit'} (${MAC ? '⌘Z' : 'Ctrl+Z'})` : `Nothing to undo here (${MAC ? '⌘Z' : 'Ctrl+Z'})`;
  br.title = r ? `Redo: ${r.label ?? 'edit'} (${MAC ? '⇧⌘Z' : 'Ctrl+Y'})` : `Nothing to redo here (${MAC ? '⇧⌘Z' : 'Ctrl+Y or Ctrl+Shift+Z'})`;
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
  state.panes.forEach((p, i) => { if (keyWs(p.key) === d.wsId) showPane(i, p.key); });
}
async function undoStep(dir) {
  if (!state.editable || state.undoBusy) return;
  const key = focusedKey();
  if (!key || (keyWs(key) == null && key !== 'cur') || (keyWs(key) != null && !canEditWs(keyWs(key)))) return;
  const h = state.undo.of(key), from = dir === 'undo' ? h.undo : h.redo, to = dir === 'undo' ? h.redo : h.undo;
  const e = from.pop();
  if (!e) { toast(dir === 'undo' ? 'Nothing to undo here' : 'Nothing to redo here'); return; }
  state.undoBusy = true; renderUndo();
  setStatus(dir === 'undo' ? 'Undoing…' : 'Redoing…');
  try {
    const back = await applyEntry(e, undoDeps);
    if (back) to.push(back);
    if (back?.kind === 'rev') state.saved.set(key, { revision: back.revision, at: new Date() });
    toast(`${dir === 'undo' ? 'Undid' : 'Redid'}: ${e.label ?? 'edit'}`);
  } catch (err) {
    if (err instanceof ApiError) toast(`Can't ${dir} “${e.label ?? 'edit'}”: ${errMsg(err)}`, true); // e.g. changed since on another device; dropped
    else { from.push(e); toast(`Can't ${dir} while offline. Try again when you're connected.`, true); }
  } finally {
    state.undoBusy = false;
    const sel = state.selection?.id, wsId = keyWs(key);
    if (wsId != null) await rerenderWs(wsId).catch(() => {}); else { await refreshHouse().catch(() => {}); renderInsp(); renderSide(); }
    if (sel) focusedPane()?.view.select(sel);
    renderUndo();
  }
}

// ---------------------------------------------------------------------------
// Dialogs: Save to Current (the summary is the approval), New design
// ---------------------------------------------------------------------------
function modal(html, cls = '') {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="modal-content ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
  document.body.appendChild(m);
  return m;
}
async function openSaveDialog(wsId) {
  if (!canEditWs(wsId)) return;
  let s;
  try { s = await api.saveToCurrentSummary(wsId); } catch (e) { return toast(errMsg(e), true); }
  const colorLine = (c) => `${esc(c.label)}: ${[c.wallColor && `walls <span class="sw" style="background:${esc(c.wallColor)}"></span>${esc(c.wallColorName ?? c.wallColor)}`, c.trimColor && `trim <span class="sw" style="background:${esc(c.trimColor)}"></span>`, c.floorColor && `floor <span class="sw" style="background:${esc(c.floorColor)}"></span>`].filter(Boolean).join(', ') || 'colors'}`;
  const m = modal(`<h2>Save “${esc(s.name)}” to Current?</h2>
    <div class="meta">This says “this is what's in the room now”. Saving updates Current right away (this is your approval), and you can roll it back from Current's History.</div>
    <h3>Goes into Current</h3>
    ${s.goesIn.length || s.colors.length ? `<ul class="tight">${s.goesIn.length ? `<li>${esc(s.goesIn.map((x) => x.name).join(', '))} <span class="meta">(marked existing/keep)</span></li>` : ''}${s.colors.map((c) => `<li>${colorLine(c)}</li>`).join('')}</ul>` : '<p class="meta">No pieces marked existing or keep, and no colors.</p>'}
    ${s.replacesCurrentPieces ? `<p class="meta">Replaces Current's ${s.replacesCurrentPieces} piece(s) in ${esc(s.rooms.map((r) => r.label).join(', '))}.</p>` : ''}
    <h3>Left out (still ideas)</h3>
    ${s.leftOut.length ? `<ul class="tight">${s.leftOut.map((x) => `<li>${esc(x.name)} <span class="meta">(marked ${esc(x.action)})</span></li>`).join('')}</ul>` : '<p class="meta">Nothing left out.</p>'}
    ${s.pending.length ? `<div class="card prop" style="margin-top:12px"><b>${s.pending.length} pending proposal${s.pending.length === 1 ? '' : 's'} on this design</b><div class="meta">${s.pending.map((p) => `#${p.id} ${esc(p.title)}`).join('; ')}. Decide ${s.pending.length === 1 ? 'it' : 'them'} first so ${s.pending.length === 1 ? "it's" : "they're"} included or left out on purpose.</div><div class="actions">${s.pending.map((p) => `<button class="b" data-review="${p.id}">Review #${p.id}</button>`).join('')}</div></div>` : ''}
    ${s.nothingToChange ? '<p class="meta"><b>Current already has this design\'s furniture and colors.</b></p>' : ''}
    <div class="actions" style="justify-content:flex-end"><button class="b" data-close>Cancel</button><button class="b primary" id="saveGo" ${s.nothingToChange ? 'disabled' : ''}>⤒ Save to Current</button></div>`, 'wide');
  m.querySelectorAll('[data-review]').forEach((b) => (b.onclick = () => { m.remove(); goToProposal(Number(b.dataset.review)); }));
  m.querySelector('#saveGo').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.saveToCurrent(wsId, s.revision);
      m.remove();
      await refreshProposals(); await refreshHouse(); await refreshList();
      await render();
      toast(`Saved to Current · rev ${r.currentRevision}`, false, () => undoApproval(r.proposalId));
    } catch (err) { e.target.disabled = false; toast(errMsg(err), true); }
  };
}
/** New design: Start from Current / Copy a design / Blank room, with a suggested, unique name. */
function openNewDesign({ mode, copyFrom } = {}) {
  if (!state.editable) return;
  const live = liveDesigns(), all = state.workspaces;
  mode ??= hasCurrent() ? 'current' : live.length ? 'copy' : 'blank';
  let src = copyFrom ?? keyWs(state.open) ?? live[0]?.id;
  if (src != null && !wsRow(src)) src = live[0]?.id;
  const room = () => (mode === 'copy' ? roomLabelOf(wsRow(src)) : currentLabel());
  const base = () => (mode === 'current' ? `${currentLabel()} · As is` : mode === 'blank' ? `${currentLabel()} · Blank` : `Copy of ${wsName(src)}`);
  const m = modal(`<h2>New design</h2><div class="meta" id="ndRoom"></div>
    <div style="margin-top:14px">
      <div class="opt ${hasCurrent() ? '' : 'dis'}" data-mode="current"><span class="r"></span><div><b>Start from Current</b><div class="meta">${hasCurrent() ? `Today's furniture and colors (rev ${state.house.current.revision})` : 'No Current yet'}</div></div></div>
      <div class="opt ${all.length ? '' : 'dis'}" data-mode="copy"><span class="r"></span><div style="flex:1"><b>Copy a design</b><div class="meta">${esc(live.map((w) => w.name).slice(0, 4).join(', ') || 'No designs yet')}</div>
        <select id="ndSrc" aria-label="Design to copy">${all.map((w) => `<option value="${w.id}" ${w.id === src ? 'selected' : ''}>${esc(w.name)}${w.archived ? ' (archived)' : ''}</option>`).join('')}</select></div></div>
      <div class="opt" data-mode="blank"><span class="r"></span><div><b>Blank room</b><div class="meta">Walls, doors and windows only</div></div></div>
    </div>
    <label style="margin-top:12px;font-weight:600" for="ndName">Name</label>
    <input id="ndName" class="field" maxlength="120" autocomplete="off">
    <div class="hint err" id="ndErr" hidden></div>
    <div class="hint meta">Names are unique per room. Suggested from the starting point; you can rename any time (click the name at the top).</div>
    <div class="actions" style="justify-content:flex-end;margin-top:16px"><button class="b" data-close>Cancel</button><button class="b primary" id="ndGo">Create design</button></div>`);
  const name = m.querySelector('#ndName'), err = m.querySelector('#ndErr'), go = m.querySelector('#ndGo');
  let touched = false, seq = 0, timer;
  const q = () => ({ name: name.value.trim(), ...(mode === 'copy' && src != null ? { copyFrom: String(src) } : {}) });
  const showTaken = (suggestion) => {
    err.hidden = false; name.classList.add('err');
    err.innerHTML = `⚠ That name is taken by another ${esc(room())} design. Try <button class="use" type="button">${esc(suggestion)}</button>, or give it a name of its own.`;
    err.querySelector('.use').onclick = () => { name.value = suggestion; touched = true; check(); };
  };
  const check = async () => {
    const n = ++seq, v = name.value.trim();
    if (!v) { err.hidden = true; name.classList.remove('err'); go.disabled = true; return; }
    go.disabled = false;
    try { const r = await api.nameCheck(q()); if (n !== seq) return; if (r.free) { err.hidden = true; name.classList.remove('err'); } else showTaken(r.suggestion); } catch { /* the server checks again on create */ }
  };
  const suggest = async () => {
    m.querySelector('#ndRoom').textContent = `Room: ${room()}`;
    m.querySelectorAll('.opt').forEach((o) => o.classList.toggle('on', o.dataset.mode === mode));
    m.querySelector('#ndSrc').disabled = mode !== 'copy';
    if (touched) return check();
    name.value = base();
    try { const r = await api.nameCheck({ ...q(), name: base() }); if (!touched) name.value = r.free ? base() : r.suggestion; } catch { /* keep the base */ }
    err.hidden = true; name.classList.remove('err'); go.disabled = false;
  };
  m.querySelectorAll('.opt').forEach((o) => (o.onclick = (e) => { if (o.classList.contains('dis') || e.target.tagName === 'SELECT') return; mode = o.dataset.mode; suggest(); }));
  m.querySelector('#ndSrc').onchange = (e) => { src = Number(e.target.value); mode = 'copy'; suggest(); };
  name.oninput = () => { touched = true; clearTimeout(timer); timer = setTimeout(check, 250); };
  name.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
  go.onclick = async () => {
    const v = name.value.replace(/\s+/g, ' ').trim(); if (!v) return;
    go.disabled = true;
    try {
      const ws = mode === 'copy' ? await api.createWorkspace(v, src) : await api.createWorkspace(v, undefined, mode === 'current' ? 'current' : 'none');
      m.remove();
      state.cache.set(ws.id, ws); await refreshList();
      await openKey(`ws:${ws.id}`, { panel: 'details' });
      toast(`Created “${ws.name}”`);
    } catch (e) {
      go.disabled = false;
      if (e instanceof ApiError && e.body?.error === 'name_taken') showTaken(e.body.details?.suggestion ?? `${v} 2`);
      else toast(errMsg(e), true);
    }
  };
  suggest(); setTimeout(() => name.focus(), 0);
  return m;
}

// ---------------------------------------------------------------------------
// Pairing and scans (scan review opens in Compare: Current vs the scan)
// ---------------------------------------------------------------------------
async function qrSvg(text) {
  try {
    const QR = (await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm')).default;
    return await QR.toString(text, { type: 'svg', margin: 1, width: 220 });
  } catch { return ''; } // offline: the code and link below still work
}
function showPairDialog(roomId) {
  if (!state.editable) return toast('Only Michael can pair a phone (sign in with your passkey)', true);
  const rooms = currentRooms();
  const m = modal(`<h2>Scan a room</h2>
    <p class="small">The code works for one scan (plus its photos), from one phone, for 60 minutes. The scan waits in the Inbox for your review; nothing changes Current until you promote it.</p>
    <label>What are you scanning?
      <select id="pairScope">
        <option value="new">A new room</option>
        ${rooms.map((r) => `<option value="${r.id}" ${r.id === roomId ? 'selected' : ''}>Rescan ${esc(r.label)} (Current)</option>`).join('')}
      </select>
    </label>
    <label id="pairLabelRow" style="margin-top:8px" ${roomId ? 'hidden' : ''}>Room name <input id="pairLabel" value="Family room" maxlength="120"></label>
    <div class="actions" style="justify-content:flex-end"><button class="b" data-close>Cancel</button><button id="pairGo" class="b primary">Create code</button></div>`);
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
      <div class="actions" style="justify-content:flex-end"><button class="b" data-close>Done</button></div>`;
  };
}
async function reviewScan(id) {
  state.scanViews.delete(id);
  try { state.scanViews.set(id, await api.scan(id)); } catch (e) { return toast(`Couldn't load scan: ${errMsg(e)}`, true); }
  if (!state.open) state.open = fallbackKey() ?? 'cur';
  state.compare = `sc:${id}`; state.showing = null; state.panel = 'details';
  closeSide();
  await render(); openInsp();
}
function scanReviewHtml(id) {
  const scan = state.scanViews.get(id);
  if (!scan) return '<p class="meta">Scan not loaded.</p>';
  const s = scan.parsed;
  const can = state.editable && scan.status === 'pending';
  const objRows = s.objects.map((o) => `<tr><td>${esc(o.label ?? o.kind)}</td><td>${fmtIn(o.widthIn)} × ${fmtIn(o.depthIn)} × ${fmtIn(o.heightIn)}</td><td>${o.template ? esc(o.template.name) : '<span class="muted">no template</span>'}</td></tr>`).join('');
  return `<h3>Review scan</h3><div class="card prop" data-scan-card="${id}">
    <div class="meta"><span class="pill ${scan.status}">${scan.status}</span> #${scan.id} · ${when(scan.createdAt)}${scan.planFrame === 1 ? ' · older parser (mirror image)' : ''}</div>
    <h4>${esc(scan.label)}</h4>
    <div class="meta">${scan.room ? `${scan.status === 'pending' ? 'Rescan of' : 'Room:'} “${esc(scan.room.label)}”` : 'Creates a new Current room'}</div>
    <p>${fmtIn(s.widthIn)} × ${fmtIn(s.depthIn)} · ceiling ${fmtIn(s.ceilingIn)} · ${s.walls.length} walls · ${s.openings.length} doors/windows/openings · ${s.objects.length} objects</p>
    <b>Photos (${scan.photos?.length ?? 0})</b>
    ${scan.photos?.length ? `<div class="photo-grid">${scan.photos.map((ph) => `<a href="${esc(ph.url)}" target="_blank" rel="noopener"><img src="${esc(ph.url)}" alt="${esc(ph.prompt ?? 'Photo')}" loading="lazy"><div class="photo-cap">${esc(ph.prompt ?? '')}${ph.note ? ` · ${esc(ph.note)}` : ''}${ph.tags?.length ? ` · ${esc(ph.tags.join(', '))}` : ''}</div></a>`).join('')}</div>` : '<p class="meta">No photos came with this scan.</p>'}
    ${s.objects.length ? `<b>Objects → closest template</b><table class="objs">${objRows}</table>` : ''}
    <p class="meta">Promoting writes one revision to Current and records every scanned value as a measurement. Pinned measurements always win. You can roll it back from Current's History. Furniture isn't imported on promote; use “Start a design from this scan” for a design with template pieces.</p>
    <div class="actions">${can ? `<button class="b primary" data-sa="promote">Promote to Current</button><button class="b danger" data-sa="reject">Reject</button>` : ''}
      ${state.editable && scan.status === 'promoted' ? (scan.designId ? `<button class="b" data-sa="design">Open its design</button>` : `<button class="b" data-sa="furnish" ${scan.canFurnish ? '' : 'disabled title="Only the scan that created the room, once the room is the right way round"'}>Start a design from this scan</button>`) : ''}
      <button class="b" data-sa="close">Close</button></div>
    <div class="reject-box" hidden><input class="reject-note" placeholder="Why not? (optional)" maxlength="1000"><div class="actions" style="margin-top:0"><button class="b danger" data-sa="reject-go">Reject scan</button><button class="b" data-sa="reject-cancel">Cancel</button></div></div>
  </div>`;
}
function wireScanReview(body) {
  const card = body.querySelector('[data-scan-card]'); if (!card) return;
  card.querySelectorAll('[data-sa]').forEach((b) => (b.onclick = () => scanAction(Number(card.dataset.scanCard), b.dataset.sa, card)));
}
async function furnishScan(id) {
  try {
    const r = await api.furnishScan(id);
    await refreshList(); await refreshScans();
    state.compare = null;
    await openKey(`ws:${r.workspaceId}`, { panel: 'details' });
    toast(r.existing ? `Opened “${r.name}”, the design this scan already made.` : `Made “${r.name}” with ${r.placements} piece(s)${r.skipped?.length ? `; skipped ${r.skipped.length}` : ''}.`);
  } catch (e) { toast(errMsg(e), true); }
}
async function scanAction(id, act, card) {
  const scan = state.scanViews.get(id);
  try {
    if (act === 'close') { state.compare = null; await render(); return; }
    if (act === 'design') { state.compare = null; await openKey(`ws:${scan.designId}`); return; }
    if (act === 'furnish') return furnishScan(id);
    if (act === 'reject') { card.querySelector('.reject-box').hidden = false; card.querySelector('.reject-note').focus(); return; }
    if (act === 'reject-cancel') { card.querySelector('.reject-box').hidden = true; return; }
    if (act === 'promote') {
      if (!confirm(`Promote “${scan.label}” to Current?\n\nThis writes one Current revision you can roll back from History.`)) return;
      const r = await api.promoteScan(id);
      toast(`Promoted as Current revision ${r.revision}${r.kept?.length ? ` · kept ${r.kept.length} pinned/used value(s)` : ''}.`);
      state.compare = null; state.open = 'cur';
    } else if (act === 'reject-go') {
      await api.rejectScan(id, card.querySelector('.reject-note').value.trim() || undefined);
      toast('Scan rejected. Kept for the record; nothing changed.');
      state.compare = null;
    }
    state.scanViews.delete(id);
    await refreshHouse(); await refreshScans(); await refreshList();
    await render();
  } catch (e) { toast(errMsg(e), true); }
}

// ---------------------------------------------------------------------------
// Phone: sidebar slide-over, inspector bottom sheet
// ---------------------------------------------------------------------------
const phone = () => matchMedia('(max-width: 760px)').matches;
function closeSide() { document.body.classList.remove('side-open'); syncScrim(); }
function openInsp() { if (phone()) { document.body.classList.add('insp-open'); syncScrim(); } }
function closeInsp() { document.body.classList.remove('insp-open'); syncScrim(); }
function syncScrim() { $('scrim').hidden = !(document.body.classList.contains('side-open') || document.body.classList.contains('insp-open')); }

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('btnSide').onclick = () => { document.body.classList.toggle('side-open'); closeInsp(); syncScrim(); };
$('scrim').onclick = () => { closeSide(); closeInsp(); };
$('btnInspOpen').onclick = () => { document.body.classList.add('insp-open'); syncScrim(); };
$('btnInspClose').onclick = closeInsp;
$('btnScan').onclick = () => showPairDialog();
$('btnInbox').onclick = (e) => { e.stopPropagation(); togglePop('inboxPop', fillInbox); };
$('btnMe').onclick = (e) => { e.stopPropagation(); togglePop('mePop', fillMe); };
$('btnGear').onclick = (e) => { e.stopPropagation(); togglePop('gearPop'); };
document.querySelectorAll('.itabs [data-tab]').forEach((b) => (b.onclick = () => setPanel(b.dataset.tab)));
function setModeAll(mode) {
  prefs.mode = mode; savePrefs();
  const targets = prefs.sync ? state.panes : [focusedPane()];
  targets.forEach((p) => p?.view.setMode(mode));
  renderViewControls(); syncFrom(focusedPane());
}
$('btn3d').onclick = () => setModeAll('3d');
$('btnTop').onclick = () => setModeAll('top');
$('btnWalls').onclick = () => { prefs.walls = prefs.walls === 'full' ? 'cut' : 'full'; savePrefs(); state.panes.forEach((p) => (p.view.walls = prefs.walls)); renderViewControls(); };
$('btnLabels').onclick = () => { prefs.labels = !prefs.labels; savePrefs(); renderViewControls(); };
$('snapToggle').onchange = (e) => { prefs.snap = e.target.checked; savePrefs(); state.panes.forEach((p) => (p.view.snap = prefs.snap)); };
$('floatbar').querySelectorAll('[data-fb]').forEach((b) => (b.onclick = () => {
  const a = b.dataset.fb;
  if (a === 'rotate') fv()?.rotateSelected(); else if (a === 'duplicate') duplicateSelected(); else deleteSelected();
}));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (document.querySelector('.modal')) { document.querySelector('.modal').remove(); return; } closePops(); }
  if (document.querySelector('.modal')) return;
  const step = shortcutFor(e, document.activeElement);
  if (step) { e.preventDefault(); undoStep(step); return; }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'r' || e.key === 'R') fv()?.rotateSelected();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') fv()?.select(null);
});
setInterval(() => { if (!document.hidden && state.me) { renderSide(); if (!$('saveStatus')?.textContent.startsWith('Sav')) renderTool(); } }, 60_000); // "edited N min ago"

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try { state.me = await api.me(); } catch (e) {
    if (e instanceof ApiError && e.status === 401) { $('signin').hidden = false; $('crumb').textContent = 'Signed out'; return; }
    $('crumb').textContent = `Can't reach the server: ${errMsg(e)}`; return;
  }
  state.editable = state.me.kind === 'user';
  document.body.classList.toggle('readonly', !state.editable);
  const url = readUrl();
  const [house] = await Promise.all([api.house(), refreshList(), refreshProposals().catch(() => {}), refreshScans()]);
  state.house = house;
  try { state.templates = await api.templates(); setTemplates(state.templates); } catch { /* older server */ }
  const saved = localStorage.getItem(LS.open);
  const valid = (k) => k && (k === 'cur' ? hasCurrent() : !!wsRow(keyWs(k)));
  state.open = [url.open, saved].find(valid) ?? fallbackKey();
  if (url.panel) state.panel = url.panel;
  if (url.compare) {
    if (keyPv(url.compare) != null) { await compareProposal(keyPv(url.compare)); }
    else if (keySc(url.compare) != null) { await reviewScan(keySc(url.compare)); }
    else if (valid(url.compare) && url.compare !== state.open) { state.compare = url.compare; state.inspHidden = !url.panel; }
  }
  await render();
  flushDrafts();
}
boot();

window.housePlanner = { state, openKey, setCompare, closeCompare, showOnPlan, compareProposal, reviewScan, showPairDialog, openNewDesign, openSaveDialog, render, setPanel };
