// Shared editor state and the single mutation entry point.

import { History, emptyDoc } from './graph.js';

export const app = {
  doc: emptyDoc(),
  history: new History(),
  level: null,                 // meta-node id being viewed; null = top level
  sel: { nodes: new Set(), edge: null },
  mode: { type: 'idle' },      // idle | place | link | move
  views: {},                   // level -> { x, y, k }
  sizes: new Map(),            // node id -> { w, h } as last rendered
  validation: null,            // last exportYaml result
  pointer: { x: 0, y: 0 },     // last pointer position, world coordinates
  pressing: false,             // a pointer press on the canvas is in progress
};

const hooks = { render: () => {}, inspector: () => {}, changed: () => {}, selection: () => {} };
export const setHooks = h => Object.assign(hooks, h);

/**
 * Apply `fn(doc)` as one undoable step. Calls sharing `key` (typing in one
 * field) coalesce. `inspector: false` keeps the side panel as it is, so an
 * input being typed in keeps its focus.
 */
export function commit(fn, { key = null, inspector = true, render = true } = {}) {
  app.history.record(app.doc, key);
  const out = fn(app.doc);
  pruneSelection();
  if (render) hooks.render();
  if (inspector) hooks.inspector();
  hooks.changed();
  return out;
}

/** Replace the whole document (open, new, undo). */
export function replaceDoc(doc, { record = true } = {}) {
  if (record) app.history.record(app.doc);
  app.doc = doc;
  if (app.level && !doc.nodes[app.level]) app.level = null;
  pruneSelection();
  hooks.render();
  hooks.inspector();
  hooks.changed();
}

export function undo() {
  const d = app.history.undo(app.doc);
  if (d) replaceDoc(d, { record: false });
}

export function redo() {
  const d = app.history.redo(app.doc);
  if (d) replaceDoc(d, { record: false });
}

function pruneSelection() {
  for (const id of [...app.sel.nodes]) if (!app.doc.nodes[id]) app.sel.nodes.delete(id);
  if (app.sel.edge && !app.doc.edges[app.sel.edge]) app.sel.edge = null;
}

export function select(ids = [], { edge = null, add = false } = {}) {
  if (!add) app.sel.nodes.clear();
  for (const id of ids) {
    if (add && app.sel.nodes.has(id)) app.sel.nodes.delete(id);
    else app.sel.nodes.add(id);
  }
  app.sel.edge = edge;
  if (edge) app.sel.nodes.clear();
  app.history.close();
  hooks.selection();
  hooks.inspector();
}

export const selectedNodes = () => [...app.sel.nodes].map(id => app.doc.nodes[id]).filter(Boolean);
export const levelKey = () => app.level || 'root';
export function view() {
  return (app.views[levelKey()] ||= { x: 80, y: 80, k: 1 });
}
