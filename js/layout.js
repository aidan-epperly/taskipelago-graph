// Layered left-to-right layout for the nodes at one level of the meta-node tree.

import { childrenOf, repAt, WIDTH } from './graph.js';

const COL_GAP = 90;
const ROW_GAP = 26;

/**
 * Lay out the children of `level`. `sizes` maps id -> {w, h} where known.
 * Edges inside meta-nodes count as edges between the meta-nodes.
 */
export function layoutLevel(doc, level, sizes = new Map(), ids = null) {
  const nodes = childrenOf(doc, level).filter(n => !ids || ids.has(n.id));
  if (!nodes.length) return;
  const inSet = new Set(nodes.map(n => n.id));
  const succ = new Map(nodes.map(n => [n.id, new Set()]));
  const pred = new Map(nodes.map(n => [n.id, new Set()]));
  for (const e of Object.values(doc.edges)) {
    const a = repAt(doc, e.from, level);
    const b = repAt(doc, e.to, level);
    if (!a || !b || a === b || !inSet.has(a) || !inSet.has(b)) continue;
    succ.get(a).add(b);
    pred.get(b).add(a);
  }
  // Membership pulls a task next to its region: treat region -> member as a soft edge
  // only for placing unconnected nodes.
  const size = n => sizes.get(n.id) || { w: WIDTH[n.kind] || 200, h: n.kind === 'gate' ? 40 : 64 };

  // Longest-path layering (cycles are broken by visiting order).
  const layer = new Map();
  const visiting = new Set();
  const depth = id => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of pred.get(id)) d = Math.max(d, depth(p) + 1);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  nodes.forEach(n => depth(n.id));
  // Pull sources right, next to their earliest consumer.
  for (const n of nodes) {
    if (pred.get(n.id).size || !succ.get(n.id).size) continue;
    const m = Math.min(...[...succ.get(n.id)].map(s => layer.get(s)));
    layer.set(n.id, Math.max(0, m - 1));
  }
  // Goal goes last.
  const maxLayer = Math.max(0, ...layer.values());
  for (const n of nodes) if (n.kind === 'goal' && !succ.get(n.id).size) layer.set(n.id, Math.max(maxLayer, layer.get(n.id)));
  // A meta-node's Input opens the first column and its Output closes the last.
  if (nodes.some(n => n.role === 'input')) {
    for (const n of nodes) layer.set(n.id, n.role === 'input' ? 0 : layer.get(n.id) + 1);
  }
  const last = Math.max(0, ...nodes.filter(n => !n.role).map(n => layer.get(n.id)));
  for (const n of nodes) if (n.role === 'output') layer.set(n.id, Math.max(last + 1, layer.get(n.id)));
  // Isolated nodes (no edges at all) sit in a column of their own on the left.
  const isolated = nodes.filter(n => !pred.get(n.id).size && !succ.get(n.id).size && n.kind !== 'goal' && !n.role);
  const connected = nodes.filter(n => !isolated.includes(n));
  const cols = [];
  for (const n of connected) {
    const l = layer.get(n.id);
    (cols[l] ||= []).push(n);
  }
  for (let i = 0; i < cols.length; i++) cols[i] ||= [];
  // Initial order: current y.
  for (const c of cols) c.sort((a, b) => a.y - b.y);
  // Barycenter sweeps.
  const pos = new Map();
  const index = () => cols.forEach(c => c.forEach((n, i) => pos.set(n.id, i)));
  index();
  const bary = (n, nbrs) => {
    const xs = [...nbrs].filter(id => pos.has(id)).map(id => pos.get(id));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : pos.get(n.id);
  };
  for (let it = 0; it < 6; it++) {
    const down = it % 2 === 0;
    const order = down ? cols.map((_, i) => i) : cols.map((_, i) => cols.length - 1 - i);
    for (const i of order) {
      const c = cols[i];
      const b = new Map(c.map(n => [n.id, bary(n, down ? pred.get(n.id) : succ.get(n.id))]));
      c.sort((x, y) => b.get(x.id) - b.get(y.id));
      c.forEach((n, k) => pos.set(n.id, k));
    }
  }

  // Very tall layers wrap into several adjacent columns, so big graphs stay wide.
  const cap = Math.max(14, Math.ceil(Math.sqrt(nodes.length) * 1.6));
  for (let i = cols.length - 1; i >= 0; i--) {
    if (cols[i].length <= cap) continue;
    const parts = [];
    for (let k = 0; k < cols[i].length; k += cap) parts.push(cols[i].slice(k, k + cap));
    cols.splice(i, 1, ...parts);
  }
  isolated.sort((a, b) => kindRank(a) - kindRank(b) || a.y - b.y);
  const isoCols = [];
  for (let k = 0; k < isolated.length; k += cap) isoCols.push(isolated.slice(k, k + cap));

  // Coordinates: columns left to right, each column centered vertically.
  const colHeights = cols.map(c => c.reduce((s, n) => s + size(n).h + ROW_GAP, -ROW_GAP));
  const tallest = Math.max(0, ...colHeights);
  let x = 0;
  isoCols.forEach((col, i) => {
    const w = Math.max(...col.map(n => size(n).w));
    let y = 0;
    for (const n of col) {
      n.x = x;
      n.y = Math.round(y);
      y += size(n).h + ROW_GAP;
    }
    x += w + (i === isoCols.length - 1 ? COL_GAP * 1.6 : ROW_GAP);
  });
  cols.forEach((c, i) => {
    const w = Math.max(0, ...c.map(n => size(n).w));
    let y = (tallest - colHeights[i]) / 2;
    for (const n of c) {
      n.x = Math.round(x + (w - size(n).w) / 2);
      n.y = Math.round(y);
      y += size(n).h + ROW_GAP;
    }
    x += w + COL_GAP;
  });
}

const RANK = { region: 0, group: 1, item: 2, task: 3, note: 4, meta: 5 };
const kindRank = n => RANK[n.kind] ?? 9;
