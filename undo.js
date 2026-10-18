// Undo/redo for the editor, one history per tab. Pure logic (no DOM, no fetch) so it can be tested in node.
//
// Every entry describes one step that can be applied; applying it returns the entry that reverses it:
//   { kind: 'rev', wsId, revision }      a saved edit: apply = a NEW revision that reverts revision N
//                                        (history is never rewritten; the server checks each field
//                                        still has the value N left, so later edits aren't clobbered)
//   { kind: 'draft', wsId, draft }       an unsaved local edit (offline): apply = drop it from the queue
//   { kind: 'requeue', wsId, draft }     apply = queue that draft again
//   { kind: 'meas', key, measurementId, withdraw, restoreIn, workspaceId }
//                                        a measurement: apply = withdraw it (or bring it back)
//   { kind: 'repin', key, body, valueIn } an unpin: apply = pin the same value again
// Entries also carry a label for tooltips and toasts.

export class UndoHistory {
  constructor(limit = 100) { this.limit = limit; this.undo = []; this.redo = []; }
  /** A new edit: it can be undone, and anything that was undone can no longer be redone. */
  record(entry) { this.undo.push(entry); if (this.undo.length > this.limit) this.undo.shift(); this.redo = []; }
  get canUndo() { return this.undo.length > 0; }
  get canRedo() { return this.redo.length > 0; }
  peekUndo() { return this.undo[this.undo.length - 1] ?? null; }
  peekRedo() { return this.redo[this.redo.length - 1] ?? null; }
  /** Replace entries in both stacks (e.g. an offline draft that has since been saved as a revision). */
  replace(match, make) {
    for (const list of [this.undo, this.redo]) for (let i = 0; i < list.length; i++) if (match(list[i])) list[i] = make(list[i]);
  }
}

/** One history per tab key ('cur', 'ws:3', ...). */
export class UndoBook {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  of(key) { if (!this.map.has(key)) this.map.set(key, new UndoHistory(this.limit)); return this.map.get(key); }
  replaceAll(match, make) { for (const h of this.map.values()) h.replace(match, make); }
}

/**
 * Apply one entry. deps: { revert(wsId, revision) -> {revision, unchanged}, dropDraft(draft) -> bool,
 * queueDraft(draft), withdraw(measurementId, withdraw, restoreIn, workspaceId), pin(body, valueIn) -> {measurementId} }.
 * Returns the reversing entry, or null when there was nothing left to do.
 */
export async function applyEntry(e, deps) {
  switch (e.kind) {
    case 'rev': {
      const r = await deps.revert(e.wsId, e.revision);
      if (r.unchanged) return null;
      return { kind: 'rev', wsId: e.wsId, revision: r.revision, label: e.label };
    }
    case 'draft': {
      if (!deps.dropDraft(e.draft)) return null; // already sent; the caller swaps the entry for a 'rev'
      return { kind: 'requeue', wsId: e.wsId, draft: e.draft, label: e.label };
    }
    case 'requeue': {
      deps.queueDraft(e.draft);
      return { kind: 'draft', wsId: e.wsId, draft: e.draft, label: e.label };
    }
    case 'meas': {
      await deps.withdraw(e.measurementId, e.withdraw, e.restoreIn, e.workspaceId);
      return { ...e, withdraw: !e.withdraw };
    }
    case 'repin': {
      const r = await deps.pin(e.body, e.valueIn);
      return { kind: 'meas', key: e.key, measurementId: r.measurementId, withdraw: true, restoreIn: undefined, workspaceId: e.body.workspaceId ?? null, label: e.label };
    }
    default: throw new Error(`Unknown undo entry ${e.kind}`);
  }
}

/** Which history step a key press asks for: 'undo', 'redo' or null. Ignored while typing. */
export function shortcutFor(e, target) {
  if (isTyping(target)) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = (e.key || '').toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey) return 'redo';
  return null;
}
export function isTyping(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].includes((el.type || 'text').toLowerCase());
  return !!el.isContentEditable;
}
