// Graph document: nodes, edges and slot settings, plus undo history.
//
// Node kinds
//   task    one Taskipelago task row (count > 1 makes interchangeable copies)
//   item    one item row
//   region  a region; tasks join it through task.region
//   group   an item group (progressive / random-choice / aesthetic); items join through item.group
//   gate    AND / OR over its inputs, for nested logic
//   goal    the single goal node; its inputs form goal_tasks
//   meta    a container; nodes whose `parent` is its id live inside it. Each holds two
//           gate nodes, its Input (role 'input') and Output (role 'output'): a link to
//           the meta-node goes to its Input, a link from it starts at its Output
//   note    free text, never exported
//
// Edges run from a source (task, item, region, group, gate) to a target (task,
// region, gate, goal). `kind: 'req'` is a requirement whose meaning is set by
// `cond` (see condLabel); `kind: 'cost'` spends a consumable item on a task.

import { REGION_COLOR_PALETTE } from '../vendor/taskipelago/js/generator/model.js';
import { defaultThemeColors } from '../vendor/taskipelago/js/shared/theme.js';

export const KINDS = ['task', 'item', 'region', 'group', 'gate', 'goal', 'meta', 'note'];
export const SOURCE_KINDS = new Set(['task', 'item', 'region', 'group', 'gate']);
export const TARGET_KINDS = new Set(['task', 'region', 'gate', 'goal']);
export const WIDTH = { task: 210, item: 190, region: 220, group: 200, gate: 64, goal: 150, meta: 240, note: 200 };

let counter = 0;
export const newId = prefix => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function defaultSettings() {
  return {
    playerName: '',
    progressionBalancing: 50,
    accessibility: 'full',
    deathLinkEnabled: false,
    deathLinkAmnesty: 0,
    deathLinkLockTasks: false,
    deathLink: [],
    lockPrereqs: true,
    hideUnreachable: true,
    taskRewardPreviews: 0,
    previewsPurchasableOnly: false,
    styleColors: defaultThemeColors(),
    clickerMode: false,
    clickerDistributeGlobal: false,
    clickerOffline: true,
    clickerOfflineRate: '1',
    clickerOfflineCapHours: 8,
    autoFiller: true,     // pad the item pool with filler so slots balance
    extraGoal: '',        // raw goal text ANDed with the goal node's inputs
  };
}

const DEFAULTS = {
  task: () => ({
    name: '', desc: '', region: '', count: 1, sequential: false, priority: false, combine: 'and',
    extraPrereq: '', extraItemPrereq: '', extraCost: '',
    activations: '', manual: false, autoComplete: false,
    renewable: false, renewableCurrency: '', renewableAmount: '',
  }),
  item: () => ({
    name: '', type: 'useful', count: 1, consumable: false, early: false, filler: false, group: '',
    clickerKind: 'none', clickerTarget: '*', clickerValue: '',
  }),
  region: () => ({
    name: '', pct: 100, color: '', parentRegion: '', combine: 'and', extraPrereq: '',
    randomOn: false, randomPick: '', randomOrder: false, disabled: false,
    manual: false, distributed: false, offlineRate: '',
  }),
  group: () => ({
    name: '', gtype: 'progressive', color: '', pick: '', pct: '', early: false, disabled: false, parentGroup: '',
  }),
  gate: () => ({ op: 'or', role: '' }),
  goal: () => ({ combine: 'and' }),
  meta: () => ({ name: 'Group', ox: 0, oy: 0, input: '', output: '' }),
  note: () => ({ text: '' }),
};

export function makeNode(kind, x, y, data = {}) {
  return { id: newId(kind[0]), kind, x, y, parent: null, ...DEFAULTS[kind](), ...data };
}

export function emptyDoc() {
  const goal = makeNode('goal', 900, 200);
  return { version: 1, settings: defaultSettings(), nodes: { [goal.id]: goal }, edges: {} };
}

/** Fill in fields added after a document was saved. */
export function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== 'object') return doc;
  doc.settings = { ...defaultSettings(), ...(raw.settings || {}) };
  doc.nodes = {};
  for (const n of Object.values(raw.nodes || {})) {
    if (!DEFAULTS[n.kind]) continue;
    doc.nodes[n.id] = { ...DEFAULTS[n.kind](), parent: null, ...n };
  }
  if (!Object.values(doc.nodes).some(n => n.kind === 'goal')) {
    const g = makeNode('goal', 900, 200);
    doc.nodes[g.id] = g;
  }
  for (const n of Object.values(doc.nodes)) if (n.kind === 'meta') ensurePorts(doc, n);
  doc.edges = {};
  for (const e of Object.values(raw.edges || {})) {
    if (doc.nodes[e.from] && doc.nodes[e.to]) doc.edges[e.id] = { kind: 'req', cond: {}, ...e };
  }
  return doc;
}

export const goalNode = doc => Object.values(doc.nodes).find(n => n.kind === 'goal');
export const nodesOf = (doc, kind) => Object.values(doc.nodes).filter(n => n.kind === kind);
export const incoming = (doc, id) => Object.values(doc.edges).filter(e => e.to === id);
export const outgoing = (doc, id) => Object.values(doc.edges).filter(e => e.from === id);

export function nextRegionColor(doc) {
  const used = nodesOf(doc, 'region').length + nodesOf(doc, 'group').length;
  return REGION_COLOR_PALETTE[used % REGION_COLOR_PALETTE.length];
}

/** Display name for any node. */
export function nodeTitle(n) {
  if (!n) return '';
  switch (n.kind) {
    case 'gate': return n.role === 'input' ? 'Input' : n.role === 'output' ? 'Output' : n.op.toUpperCase();
    case 'goal': return 'Goal';
    case 'note': return (n.text || 'Note').split('\n')[0].slice(0, 40);
    default: return n.name || `Untitled ${n.kind}`;
  }
}

/** Can an edge run from a to b? Returns null or a reason. */
export function edgeProblem(doc, a, b, kind = 'req') {
  if (!a || !b) return 'Missing node.';
  if (a.id === b.id) return 'A node cannot depend on itself.';
  if (kind === 'cost') {
    if (a.kind !== 'item' || !a.consumable) return 'Costs come from consumable items.';
    if (b.kind !== 'task') return 'Only tasks have costs.';
    return null;
  }
  if (!SOURCE_KINDS.has(a.kind)) return `A ${a.kind} cannot be a requirement.`;
  if (!TARGET_KINDS.has(b.kind)) {
    return b.kind === 'item'
      ? 'Items are shuffled into the multiworld, so they cannot have requirements.'
      : `A ${b.kind} cannot have requirements.`;
  }
  if (Object.values(doc.edges).some(e => e.from === a.id && e.to === b.id && e.kind === kind)) {
    return 'That link already exists.';
  }
  if (reaches(doc, b.id, a.id)) return 'That link would create a cycle.';
  return null;
}

/** Is `to` reachable from `from` along edges? */
export function reaches(doc, from, to) {
  const out = new Map();
  for (const e of Object.values(doc.edges)) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const v = stack.pop();
    if (v === to) return true;
    for (const w of out.get(v) || []) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  }
  return false;
}

export function defaultCond(a) {
  switch (a.kind) {
    case 'item': return { copies: 1 };
    case 'region': return { mode: 'default', n: 100 };
    case 'group': return { mode: 'count', n: 1 };
    default: return {};
  }
}

/** Short edge label; '' for the plain "done / received" case. */
export function condLabel(doc, e) {
  const a = doc.nodes[e.from];
  const c = e.cond || {};
  if (e.kind === 'cost') return `spend ${c.amount || 1}`;
  if (!a) return '';
  switch (a.kind) {
    case 'item': return (c.copies || 1) > 1 ? `×${c.copies}` : '';
    case 'region':
      if (c.mode === 'pct') return `${c.n}%`;
      if (c.mode === 'count') return `${c.n} task${c.n === 1 ? '' : 's'}`;
      return `${a.pct ?? 100}%`;
    case 'group':
      if (c.mode === 'pct') return `${c.n}%`;
      if (c.mode === 'next') return 'next';
      if (c.mode === 'position') return `#${c.n}`;
      return `≥ ${c.n}`;
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Meta-node hierarchy
// ---------------------------------------------------------------------------

export function ancestors(doc, id) {
  const out = [];
  let p = doc.nodes[id]?.parent;
  while (p && doc.nodes[p]) { out.push(p); p = doc.nodes[p].parent; }
  return out;
}

/** The node that stands for `id` when looking at level `level` (null = root), or null if outside. */
export function repAt(doc, id, level) {
  let cur = id;
  while (cur) {
    const n = doc.nodes[cur];
    if (!n) return null;
    if ((n.parent || null) === (level || null)) return cur;
    cur = n.parent;
  }
  return null;
}

export const childrenOf = (doc, level) => Object.values(doc.nodes).filter(n => (n.parent || null) === (level || null));

export function descendants(doc, metaId) {
  const out = [];
  const stack = [metaId];
  while (stack.length) {
    const p = stack.pop();
    for (const n of Object.values(doc.nodes)) if (n.parent === p) { out.push(n); stack.push(n.id); }
  }
  return out;
}

/** Make sure a meta-node has its Input and Output gates, placed at the edges of its contents. */
export function ensurePorts(doc, meta) {
  const kids = Object.values(doc.nodes).filter(n => n.parent === meta.id && !n.role);
  const xs = kids.map(n => n.x);
  const ys = kids.map(n => n.y);
  const x0 = xs.length ? Math.min(...xs) : meta.ox;
  const x1 = xs.length ? Math.max(...xs) + 210 : meta.ox + 400;
  const y = ys.length ? Math.round((Math.min(...ys) + Math.max(...ys)) / 2) : meta.oy;
  for (const [role, x] of [['input', x0 - 220], ['output', x1 + 100]]) {
    const have = doc.nodes[meta[role]];
    if (have && have.parent === meta.id) continue;
    const g = makeNode('gate', Math.round(x), y, { op: 'and', role });
    g.parent = meta.id;
    doc.nodes[g.id] = g;
    meta[role] = g.id;
  }
}

/** A meta-node's Input / Output gate (a link to or from the card uses these), else the id itself. */
export function portFor(doc, id, which) {
  const n = doc.nodes[id];
  return n && n.kind === 'meta' && doc.nodes[n[which]] ? n[which] : id;
}

/** Group node ids (all at the same level) into a new meta-node. */
export function groupInto(doc, ids, name = 'Group') {
  const nodes = ids.map(id => doc.nodes[id]).filter(n => n && n.kind !== 'goal' && !n.role);
  if (!nodes.length) return null;
  const level = nodes[0].parent || null;
  const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
  const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
  const meta = makeNode('meta', Math.round(cx), Math.round(cy), { name, ox: cx, oy: cy });
  meta.parent = level;
  doc.nodes[meta.id] = meta;
  for (const n of nodes) n.parent = meta.id;
  ensurePorts(doc, meta);
  return meta;
}

/** Dissolve a meta-node, putting its children back at its level. */
export function ungroup(doc, metaId) {
  const m = doc.nodes[metaId];
  if (!m || m.kind !== 'meta') return [];
  // Its ports become ordinary gates; an unused one goes away. An unwired Output stood for
  // "every task inside is done", so it gets those links before it is flattened.
  for (const role of ['input', 'output']) {
    const g = doc.nodes[m[role]];
    if (!g) continue;
    const ins = Object.values(doc.edges).filter(e => e.to === g.id);
    const outs = Object.values(doc.edges).filter(e => e.from === g.id);
    if (!ins.length && !outs.length) { delete doc.nodes[g.id]; continue; }
    if (role === 'output' && !ins.length) {
      for (const t of descendants(doc, metaId)) if (t.kind === 'task') addEdge(doc, t.id, g.id);
      g.op = 'and';
    }
    g.role = '';
  }
  const kids = Object.values(doc.nodes).filter(n => n.parent === metaId);
  for (const n of kids) {
    n.parent = m.parent || null;
    n.x = Math.round(n.x + m.x - m.ox);
    n.y = Math.round(n.y + m.y - m.oy);
  }
  delete doc.nodes[metaId];
  return kids.map(n => n.id);
}

export function deleteNodes(doc, ids) {
  const kill = new Set();
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || n.kind === 'goal') continue;
    // A meta-node's Input and Output only go with the meta-node itself.
    if (n.role && !ids.includes(n.parent)) continue;
    kill.add(id);
    if (n.kind === 'meta') for (const d of descendants(doc, id)) if (d.kind !== 'goal') kill.add(d.id);
  }
  // A goal inside a deleted meta-node moves up instead of vanishing.
  for (const n of Object.values(doc.nodes)) {
    if (n.kind === 'goal' && kill.has(n.parent)) n.parent = null;
  }
  for (const id of kill) delete doc.nodes[id];
  for (const [eid, e] of Object.entries(doc.edges)) if (kill.has(e.from) || kill.has(e.to)) delete doc.edges[eid];
  for (const n of Object.values(doc.nodes)) {
    if (n.kind === 'task') {
      if (kill.has(n.region)) n.region = '';
      if (kill.has(n.renewableCurrency)) n.renewableCurrency = '';
    }
    if (n.kind === 'item' && kill.has(n.group)) n.group = '';
    if (n.kind === 'region' && kill.has(n.parentRegion)) n.parentRegion = '';
    if (n.kind === 'group' && kill.has(n.parentGroup)) n.parentGroup = '';
  }
  return kill.size;
}

export function addEdge(doc, from, to, kind = 'req', cond = null) {
  const a = doc.nodes[from];
  const e = { id: newId('e'), from, to, kind, cond: cond || (kind === 'cost' ? { amount: 1 } : defaultCond(a)) };
  doc.edges[e.id] = e;
  return e;
}

// ---------------------------------------------------------------------------
// Undo history: whole-document snapshots, cheap at this size.
// ---------------------------------------------------------------------------

export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.openKey = null;
  }

  /** Record `doc` before a change. Calls sharing a non-null key coalesce into one step. */
  record(doc, key = null) {
    if (key !== null && key === this.openKey) return;
    this.openKey = key;
    this.past.push(JSON.stringify(doc));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  close() { this.openKey = null; }

  undo(doc) {
    if (!this.past.length) return null;
    this.future.push(JSON.stringify(doc));
    this.openKey = null;
    return JSON.parse(this.past.pop());
  }

  redo(doc) {
    if (!this.future.length) return null;
    this.past.push(JSON.stringify(doc));
    this.openKey = null;
    return JSON.parse(this.future.pop());
  }
}
